#!/usr/bin/env python3
"""Run the in-game addon (addon/ForeverTrades) outside the game: Lua 5.4 through ctypes (liblua5.4 must be
installed; WoW uses Lua 5.1, so keep the addon to 5.1 syntax), with a small fake of the game's API. It loads a
data file written by the pipeline, opens a fake Blackwater and then a fake Alliance auction house, gives the
player some listings and bag items, and checks what the window shows.

    python3 tools/addon_test.py site/data/ForeverTrades_Data.lua
"""
import ctypes, os, sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
ADDON = os.path.join(ROOT, 'addon', 'ForeverTrades')

FAKE_GAME = r'''
local function noop() end
local W = {}
local function new(kind)
  local o = { _kind = kind, _shown = true, _scripts = {}, _checked = false }
  -- like a real frame: its methods (Capitalised) exist and do nothing unless faked above; other fields are nil
  return setmetatable(o, { __index = function(t, k)
    if W[k] then return W[k] end
    if type(k) == "string" and k:match("^%u") and k ~= "TitleText" then return noop end
  end })
end
function W:SetText(t) self._text = t end
function W:GetText() return self._text end
function W:Show() self._shown = true end
function W:Hide() self._shown = false end
function W:IsShown() return self._shown end
function W:SetScript(k, f) self._scripts[k] = f end
function W:GetScript(k) return self._scripts[k] end
function W:SetChecked(v) self._checked = v end
function W:GetChecked() return self._checked end
function W:CreateFontString() return new("FontString") end
function W:CreateTexture() return new("Texture") end
KNOWN_EVENTS = { ADDON_LOADED = 1, AUCTION_HOUSE_SHOW = 1, AUCTION_HOUSE_CLOSED = 1, OWNED_AUCTIONS_UPDATED = 1,
                 AUCTION_HOUSE_AUCTION_CREATED = 1, AUCTION_CANCELED = 1, BAG_UPDATE_DELAYED = 1,
                 REPLICATE_ITEM_LIST_UPDATE = 1, COMMODITY_SEARCH_RESULTS_UPDATED = 1, ITEM_SEARCH_RESULTS_UPDATED = 1,
                 AUCTION_HOUSE_THROTTLED_SYSTEM_READY = 1 }
function W:RegisterEvent(e) if not KNOWN_EVENTS[e] then error("unknown event " .. e) end end
function CreateFrame(kind, name, parent, template)
  local f = new(kind)
  if template and template:find("BasicFrameTemplate") then f.TitleText = new("FontString") end
  if name then _G[name] = f end
  return f
end
UIParent, GameTooltip = new("Frame"), new("GameTooltip")
ZONE, SUBZONE, OWNED, BAGS, QUERIES, SEARCHED = "Stormwind City", "", {}, {}, 0, nil
time, date = os.time, os.date                            -- the game has time() and date(), not os
TIMERS = {}
C_Timer = { After = function(sec, fn) TIMERS[#TIMERS + 1] = fn end }
function runTimers(max) local n = 0 while #TIMERS > 0 and n < (max or 100000) do table.remove(TIMERS, 1)(); n = n + 1 end return n end
REPLICATE, REPLICATE_CALLS, SEARCH_RESULTS, SEARCHES = {}, 0, {}, {}
function UnitName() return "Tester" end
function GetRealmName() return "Realm" end
function UnitFactionGroup() return "Alliance", "Alliance" end
function GetRealZoneText() return ZONE end
function GetSubZoneText() return SUBZONE end
function IsShiftKeyDown() return false end
SlashCmdList = {}
C_AuctionHouse = {
  QueryOwnedAuctions = function(sorts) QUERIES = QUERIES + 1 end,
  GetNumOwnedAuctions = function() return #OWNED end,
  GetOwnedAuctionInfo = function(i) return OWNED[i] end,
  -- one full read of the house: listings are { id, count, buyout, owner }, read 0-based
  ReplicateItems = function() REPLICATE_CALLS = REPLICATE_CALLS + 1 end,
  GetNumReplicateItems = function() return #REPLICATE end,
  GetReplicateItemInfo = function(i)
    local r = REPLICATE[i + 1]
    return "name", 0, r.count, 1, true, 1, 0, 0, 0, r.buyout, 0, false, nil, r.owner, r.owner, 0, r.id, true
  end,
  -- one search per item (when a full read isn't allowed): results are given by the test
  IsThrottledMessageSystemReady = function() return true end,
  MakeItemKey = function(id) return { itemID = id } end,
  SendSearchQuery = function(key, sorts, separate) SEARCHES[#SEARCHES + 1] = key.itemID end,
  GetNumCommoditySearchResults = function(id) return #(SEARCH_RESULTS[id] or {}) end,
  GetCommoditySearchResultInfo = function(id, i) return (SEARCH_RESULTS[id] or {})[i] end,
}
-- answer the addon's searches one at a time, as the game does
function pumpSearches()
  local n = 0
  while #SEARCHES > 0 do
    local id = table.remove(SEARCHES, 1)
    fire("COMMODITY_SEARCH_RESULTS_UPDATED", id)
    n = n + 1
  end
  return n
end
C_Item = { GetItemInfo = function(id) return nil end, GetItemCount = function(id) return BAGS[id] or 0 end }
AuctionHouseFrame = new("Frame")
AuctionHouseFrame.SearchBar = { SearchBox = new("EditBox"), StartSearch = function(self) SEARCHED = self.SearchBox._text end }
function fire(event, arg) ForeverTradesEvents:GetScript("OnEvent")(ForeverTradesEvents, event, arg) end
function rows()
  local out, f = {}, ForeverTradesFrame
  for k = 1, 400 do
    local r = f.rows[k]
    if not r then break end
    if r._shown then out[#out + 1] = r end
  end
  return out
end
function heads()
  local out = {}
  for k = 1, 50 do
    local h = ForeverTradesFrame.heads[k]
    if not h then break end
    if h._shown then out[#out + 1] = h._text end
  end
  return out
end
'''

SCENARIO = r'''
local D = ForeverTradesData
assert(D and D.alliance and D.alliance.toHome and D.alliance.toNeutral, "data file has the Alliance lists")
local out = {}
local function say(...) local t = {} for i = 1, select("#", ...) do t[#t + 1] = tostring(select(i, ...)) end out[#out + 1] = table.concat(t, " ") end
fire("ADDON_LOADED", "ForeverTrades")

-- 1. Blackwater (Gadgetzan). Listing: the top "buy here, sell in Alliance" item; bags: the second one.
ZONE = "Tanaris"; SUBZONE = "Gadgetzan"
local top, second = D.alliance.toHome[1], D.alliance.toHome[2]
local away = D.alliance.toNeutral[1]
fire("AUCTION_HOUSE_SHOW")
assert(QUERIES == 1, "asked the game for my listings")
assert(ForeverTradesFrame._shown, "window opens with the auction house")
say("where:", ForeverTradesFrame.where._text)
OWNED = { { itemKey = { itemID = top.id }, status = 0, quantity = 3 },
          { itemKey = { itemID = 999999 }, status = 1, quantity = 1 } }       -- a sold one: not "selling"
BAGS[second.id] = 4
fire("OWNED_AUCTIONS_UPDATED")
local h = heads()
say("sections:", h[1], "|", h[2])
assert(h[1]:find("Buy here now, sell in the Alliance house", 1, true), "Blackwater: first list is buy here -> sell at home")
local ids = {}
for _, r in ipairs(rows()) do ids[r.o.id] = r end
assert(not ids[top.id], "an item I'm selling here is left out")
assert(ids[second.id] and ids[second.id].name._text:find("4 in your bags", 1, true), "bag count shown")
say("hide line:", ForeverTradesFrame.hideText._text)
assert(rows()[1].l3._text and rows()[1].l3._text:find("sold a day", 1, true), "third line: sales")
say("first row:", rows()[1].name._text, "/", rows()[1].l1._text, "/", rows()[1].l2._text, "/", rows()[1].l3._text)
rows()[1]._scripts.OnClick(rows()[1])
assert(SEARCHED == rows()[1].o.name, "click searches the auction house")
say("clicked, searched for:", SEARCHED)
-- untick: the hidden item comes back, marked
ForeverTradesFrame.hide._checked = false; ForeverTradesFrame.hide._scripts.OnClick(ForeverTradesFrame.hide)
local back = false
for _, r in ipairs(rows()) do if r.o.id == top.id then back = r.name._text:find("you're selling 3", 1, true) ~= nil end end
assert(back, "unticked: my own item is shown, marked")
ForeverTradesFrame.hide._checked = true; ForeverTradesFrame.hide._scripts.OnClick(ForeverTradesFrame.hide)
fire("AUCTION_HOUSE_CLOSED")
assert(not ForeverTradesFrame._shown, "window closes with the auction house")

-- 2. Stormwind: Blackwater listings are remembered; my Alliance listing of the top toNeutral item is read now.
ZONE = "Stormwind City"; SUBZONE = "Trade District"; OWNED = { { itemKey = { itemID = away.id }, status = 0, quantity = 1 } }
fire("AUCTION_HOUSE_SHOW"); fire("OWNED_AUCTIONS_UPDATED")
h = heads()
say("sections:", h[1], "|", h[2])
assert(h[1]:find("Buy here now, sell on Blackwater", 1, true), "home house: first list is buy here -> sell on Blackwater")
ids = {}
for _, r in ipairs(rows()) do ids[r.o.id] = true end
assert(not ids[top.id] and not ids[away.id], "both houses' listings are left out")
say("hide line:", ForeverTradesFrame.hideText._text)
say("rows shown:", #rows(), "of", #D.alliance.toHome + #D.alliance.toNeutral)
say("age line:", ForeverTradesFrame.age._text)

-- 3. Live prices at Blackwater: a full read of the house. One trade is cheaper here now, one isn't listed,
--    and on the "sell here" list someone undercuts the website's price; my own cheap listing doesn't count.
fire("AUCTION_HOUSE_CLOSED")
local cheap, missing, comp, mineL = D.alliance.toHome[3], D.alliance.toHome[4], D.alliance.toNeutral[2], D.alliance.toHome[5]
REPLICATE = { { id = cheap.id, count = 2, buyout = math.floor(cheap.buy / 2) * 2, owner = "Someone" },
              { id = cheap.id, count = 1, buyout = cheap.buy * 3, owner = "Someone" },
              { id = comp.id, count = 1, buyout = math.floor((comp.top or comp.sell) * 0.7), owner = "Other" },
              { id = mineL.id, count = 1, buyout = 1, owner = "Tester" } }
for k = 1, 12000 do REPLICATE[#REPLICATE + 1] = { id = 1, count = 1, buyout = 100, owner = "x" } end   -- other items
ZONE = "Tanaris"; SUBZONE = "Gadgetzan"; OWNED = {}
ForeverTradesDB.lastReplicate = nil
fire("AUCTION_HOUSE_SHOW"); fire("OWNED_AUCTIONS_UPDATED")
runTimers(1)                                                  -- the scan starts shortly after opening
assert(REPLICATE_CALLS == 1, "asked for a full read of the house")
fire("REPLICATE_ITEM_LIST_UPDATE"); runTimers()
say("live line:", ForeverTradesFrame.liveText._text)
assert(ForeverTradesFrame.liveText._text:find("Live prices from here", 1, true), "full read finished")
local byId = {}
for _, r in ipairs(rows()) do byId[r.o.id] = r end
local c = byId[cheap.id]
assert(c and c.live._text:find("Here now", 1, true) and math.abs(c.o.buy - math.floor(cheap.buy / 2)) < 1, "cheaper here now: buy price re-priced")
assert(math.abs(c.o.each - (cheap.back - c.o.buy)) < 1, "profit re-worked from the live price")
say("cheaper now:", cheap.name, "/", c.live._text, "/", c.l2._text)
local m = byId[missing.id]
assert(m and m.live._text:find("None listed here right now", 1, true) and m.o.pays == false, "not listed here: doesn't pay now")
local last = rows()[#rows()]
say("not listed:", missing.name, "/", m.live._text)
local cp = byId[comp.id]
if cp then
  assert(cp.o.sell < (comp.top or comp.sell) and cp.live._text:find("Cheapest here now", 1, true), "sell-here: undercut by a live listing")
  say("undercut:", comp.name, "/", cp.live._text, "/", cp.l1._text)
end
local ml = byId[mineL.id]
assert(not ml or not (ml.o.buy == 1), "my own listing is not the price here")
-- the trades that no longer pay are listed after the ones that do, in each list
local h1 = heads()[1]
say("first list heading:", h1)

-- 4. Live prices at Stormwind, item by item (a full read was used less than 15 minutes ago)
fire("AUCTION_HOUSE_CLOSED")
local s1 = D.alliance.toNeutral[3]
SEARCH_RESULTS = { [s1.id] = { { unitPrice = math.floor(s1.buy * 0.8), quantity = 5, numOwnerItems = 0 } } }
ZONE = "Stormwind City"; SUBZONE = ""; TIMERS = {}
fire("AUCTION_HOUSE_SHOW"); fire("OWNED_AUCTIONS_UPDATED")
runTimers(1)
assert(REPLICATE_CALLS == 1, "no second full read within 15 minutes")
local answered = pumpSearches()
TIMERS = {}
say("searched", answered, "items one by one;", ForeverTradesFrame.liveText._text)
assert(answered >= 100, "every listed item was searched")
byId = {}
for _, r in ipairs(rows()) do byId[r.o.id] = r end
assert(byId[s1.id] and byId[s1.id].live._text:find("Here now", 1, true), "searched item re-priced")
say("searched item:", s1.name, "/", byId[s1.id].live._text, "/", byId[s1.id].l1._text)

-- 5. The house switch, and money formatting
ForeverTradesFrame.isNeutral._scripts.OnClick(); runTimers(); pumpSearches(); TIMERS = {}
assert(heads()[1]:find("Buy here now, sell in the Alliance house", 1, true), "switch to Blackwater")
local M = ForeverTradesLogic.Money
assert(M(5) == "5|cffeda55fc|r" and M(12345):find("1|cffffd100g|r 23", 1, true) and M(1500000) == "150|cffffd100g|r", "money")
SlashCmdList.FOREVERTRADES("reset")
return table.concat(out, "\n")
'''


def lua():
    L = ctypes.CDLL('liblua5.4.so.0')
    L.luaL_newstate.restype = ctypes.c_void_p
    L.luaL_openlibs.argtypes = [ctypes.c_void_p]
    L.luaL_loadbufferx.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.c_char_p]
    L.lua_pcallk.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
    L.lua_tolstring.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    L.lua_tolstring.restype = ctypes.c_char_p
    L.lua_settop.argtypes = [ctypes.c_void_p, ctypes.c_int]
    s = L.luaL_newstate()
    L.luaL_openlibs(s)

    def run(code, name):
        b = code.encode('utf-8')
        if L.luaL_loadbufferx(s, b, len(b), ('@' + name).encode(), None) != 0 or L.lua_pcallk(s, 0, 1, 0, None, None) != 0:
            sys.exit(f'FAILED in {name}: ' + L.lua_tolstring(s, -1, None).decode('utf-8', 'replace'))
        r = L.lua_tolstring(s, -1, None)
        L.lua_settop(s, 0)
        return r.decode('utf-8', 'replace') if r else None
    return run


def main():
    data = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'site', 'data', 'ForeverTrades_Data.lua')
    run = lua()
    run(FAKE_GAME, 'fake_game.lua')
    toc = [l.strip() for l in open(os.path.join(ADDON, 'ForeverTrades.toc')) if l.strip() and not l.startswith('#')]
    for f in toc:                                            # in the TOC's order, with the real data file
        path = data if f == 'ForeverTrades_Data.lua' else os.path.join(ADDON, f)
        run(open(path, encoding='utf-8').read(), f)
    print(run(SCENARIO, 'scenario.lua'))
    print('addon test OK')


if __name__ == '__main__':
    main()
