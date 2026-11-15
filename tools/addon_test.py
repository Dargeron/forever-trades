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
                 AUCTION_HOUSE_AUCTION_CREATED = 1, AUCTION_CANCELED = 1, BAG_UPDATE_DELAYED = 1 }
function W:RegisterEvent(e) if not KNOWN_EVENTS[e] then error("unknown event " .. e) end end
function CreateFrame(kind, name, parent, template)
  local f = new(kind)
  if template and template:find("BasicFrameTemplate") then f.TitleText = new("FontString") end
  if name then _G[name] = f end
  return f
end
UIParent, GameTooltip = new("Frame"), new("GameTooltip")
ZONE, SUBZONE, OWNED, BAGS, QUERIES, SEARCHED = "Stormwind City", "", {}, {}, 0, nil
time = os.time                                           -- the game has time(), not os
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
}
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

-- 3. The house switch, and money formatting
ForeverTradesFrame.isNeutral._scripts.OnClick()
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
