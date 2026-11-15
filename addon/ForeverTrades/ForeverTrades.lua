-- Forever Trades: shows the website's cross-faction trades at the auction house, from where you stand
-- (Blackwater or your faction's house), leaving out what you already have listed, and re-priced with what the
-- auction house you're at lists right now. The other house's prices and the sales figures come from
-- ForeverTrades_Data.lua (run UpdateData to refresh it, then /reload).

local L = ForeverTradesLogic
local FT = CreateFrame("Frame", "ForeverTradesEvents")
ForeverTrades = FT

local ROW_H, WIDTH, HEIGHT = 66, 430, 580
local REPLICATE_EVERY = 15 * 60                         -- the game allows one full read of the auction house per 15 min
local db                                                -- ForeverTradesDB (saved per account)
local state = { house = nil, atAH = false, scanned = false }
local live = { house = nil, prices = {}, checked = {}, busy = false }

local function charKey()
  local name, realm = UnitName("player"), GetRealmName and GetRealmName() or ""
  return (name or "?") .. "-" .. (realm or "")
end

local function faction()
  local f = UnitFactionGroup("player")
  return f and f:lower() or "alliance"
end

local function itemInfo(id)
  local get = (C_Item and C_Item.GetItemInfo) or GetItemInfo
  if not get then return nil end
  local name, link, quality = get(id)
  return name, link, quality
end

local function bagCount(id)
  local count = (C_Item and C_Item.GetItemCount) or GetItemCount
  return count and count(id) or 0
end

local function qualityColor(q)
  local c = ITEM_QUALITY_COLORS and ITEM_QUALITY_COLORS[q or 1]
  if c and c.hex then return c.hex end
  local hex = { [0] = "|cff9d9d9d", "|cffffffff", "|cff1eff00", "|cff0070dd", "|cffa335ee", "|cffff8000" }
  return hex[q or 1] or "|cffffffff"
end

local function after(sec, fn)
  if C_Timer and C_Timer.After then C_Timer.After(sec, fn) end
end

-- ---------------------------------------------------------------- your listings
function FT:RequestOwned()
  if C_AuctionHouse and C_AuctionHouse.QueryOwnedAuctions then
    pcall(C_AuctionHouse.QueryOwnedAuctions, {})
  elseif GetOwnerAuctionItems then
    pcall(GetOwnerAuctionItems)
  end
end

function FT:ReadOwned()
  local items, n = {}, 0
  if C_AuctionHouse and C_AuctionHouse.GetNumOwnedAuctions then
    for i = 1, C_AuctionHouse.GetNumOwnedAuctions() do
      local a = C_AuctionHouse.GetOwnedAuctionInfo(i)
      local id = a and a.itemKey and a.itemKey.itemID
      if id and a.status ~= 1 then                        -- status 1: sold, the money is in the mail
        items[id] = (items[id] or 0) + (a.quantity or 1); n = n + 1
      end
    end
  elseif GetNumAuctionItems then                        -- older auction house interface
    for i = 1, GetNumAuctionItems("owner") do
      local link = GetAuctionItemLink("owner", i)
      local id = link and tonumber(link:match("item:(%d+)"))
      local _, _, count, _, _, _, _, _, _, _, _, _, _, _, _, saleStatus = GetAuctionItemInfo("owner", i)
      if id and saleStatus ~= 1 then items[id] = (items[id] or 0) + (count or 1); n = n + 1 end
    end
  end
  return items, n
end

function FT:StoreOwned()
  if not state.house then return end
  local items, n = self:ReadOwned()
  local mine = db.owned[charKey()] or {}
  db.owned[charKey()] = mine
  mine[state.house] = { t = time(), items = items, n = n }
  state.scanned = true
  self:Refresh()
end

-- ---------------------------------------------------------------- live prices at the house you're at
-- Every item on the two lists is checked: first with one full read of the auction house (allowed once every
-- 15 minutes), otherwise with one search per item. Your own listings don't count as the price here.
local function wanted()
  local want, n = {}, 0
  for _, sec in ipairs(L.Sections(ForeverTradesData, faction(), state.house)) do
    for _, o in ipairs(sec.items) do
      if not want[o.id] then want[o.id] = true; n = n + 1 end
    end
  end
  return want, n
end

local function liveFor(id)
  if live.house ~= state.house or not live.checked[id] then return nil end
  return live.prices[id] or false
end

local function record(id, low, qty)
  live.checked[id] = true
  if low then live.prices[id] = { low = low, qty = qty } else live.prices[id] = nil end
end

function FT:FinishLive()
  live.busy, live.mode, live.pending, live.t = false, nil, nil, time()
  self:Refresh()
end

function FT:StopLive()
  if live.busy then live.busy = false; live.mode = nil; live.pending = nil; live.stopped = true end
  self:Refresh()
end

function FT:ScanLive()
  if not state.atAH or not C_AuctionHouse or not ForeverTradesData then return end
  local want, n = wanted()
  live = { house = state.house, prices = {}, checked = {}, want = want, total = n, done = 0, busy = true }
  local last = db.lastReplicate or 0
  if C_AuctionHouse.ReplicateItems and C_AuctionHouse.GetNumReplicateItems and time() - last > REPLICATE_EVERY then
    live.mode = "replicate"
    db.lastReplicate = time()
    local token = live
    pcall(C_AuctionHouse.ReplicateItems)
    after(45, function()                                 -- no answer: search item by item instead
      if live == token and live.busy and live.mode == "replicate" and not live.reading then FT:ScanSearch() end
    end)
  else
    self:ScanSearch()
  end
  self:Refresh()
end

function FT:ReadReplicate()
  if live.reading then return end
  live.reading = true
  local n = C_AuctionHouse.GetNumReplicateItems() or 0
  local me = UnitName("player")
  local low, qty, i, token = {}, {}, 0, live
  live.total, live.done = n, 0
  local function chunk()
    if live ~= token or not live.busy then return end
    local stop = math.min(i + 5000, n)
    for k = i, stop - 1 do                              -- 0-based
      local _, _, count, _, _, _, _, _, _, buyout, _, _, _, owner, _, _, id = C_AuctionHouse.GetReplicateItemInfo(k)
      if id and live.want[id] and buyout and buyout > 0 and (count or 0) > 0 and owner ~= me then
        local u = buyout / count
        if not low[id] or u < low[id] then low[id] = u end
        qty[id] = (qty[id] or 0) + count
      end
    end
    i = stop
    live.done = i
    if i < n then
      if i % 25000 < 5000 then FT:Refresh() end
      after(0, chunk)
    else
      for id in pairs(live.want) do record(id, low[id], qty[id] or 0) end
      FT:FinishLive()
    end
  end
  chunk()
end

function FT:ScanSearch()
  live.mode, live.queue, live.done = "search", {}, 0
  for id in pairs(live.want) do live.queue[#live.queue + 1] = id end
  table.sort(live.queue, function(a, b) return a > b end)
  live.total = #live.queue
  self:NextSearch()
end

function FT:NextSearch()
  if not live.busy or live.mode ~= "search" or live.pending then return end
  local id = table.remove(live.queue)
  if not id then self:FinishLive(); return end
  if C_AuctionHouse.IsThrottledMessageSystemReady and not C_AuctionHouse.IsThrottledMessageSystemReady() then
    live.queue[#live.queue + 1] = id                  -- the game asks addons to wait between searches
    after(0.5, function() FT:NextSearch() end)
    return
  end
  live.pending = id
  local token = live
  local ok = pcall(C_AuctionHouse.SendSearchQuery, C_AuctionHouse.MakeItemKey(id), { { sortOrder = 0, reverseSort = false } }, true)
  if not ok then live.pending = nil; live.done = live.done + 1; after(0.2, function() FT:NextSearch() end); return end
  after(5, function()                                  -- no answer: leave the website's figures for this one
    if live == token and live.pending == id then live.pending = nil; live.done = live.done + 1; FT:NextSearch() end
  end)
end

local function searched(id, low, qty)
  if live.mode ~= "search" or live.pending ~= id then return end
  record(id, low, qty)
  live.pending = nil
  live.done = live.done + 1
  if live.done % 10 == 0 then FT:Refresh() end
  FT:NextSearch()
end

function FT:CommodityResults(id)
  if live.pending ~= id then return end
  local low, qty = nil, 0
  for i = 1, C_AuctionHouse.GetNumCommoditySearchResults(id) or 0 do
    local r = C_AuctionHouse.GetCommoditySearchResultInfo(id, i)
    local avail = r and ((r.quantity or 0) - (r.numOwnerItems or 0)) or 0
    if avail > 0 and r.unitPrice then
      if not low or r.unitPrice < low then low = r.unitPrice end
      qty = qty + avail
    end
  end
  searched(id, low, qty)
end

function FT:ItemResults(key)
  local id = key and key.itemID
  if not id or live.pending ~= id then return end
  local low, qty = nil, 0
  for i = 1, C_AuctionHouse.GetNumItemSearchResults(key) or 0 do
    local r = C_AuctionHouse.GetItemSearchResultInfo(key, i)
    if r and not r.containsOwnerItem and r.buyoutAmount and r.buyoutAmount > 0 then
      local u = r.buyoutAmount / math.max(1, r.quantity or 1)
      if not low or u < low then low = u end
      qty = qty + (r.quantity or 1)
    end
  end
  searched(id, low, qty)
end

-- ---------------------------------------------------------------- searching the auction house for the player
local function searchFor(name)
  local f = AuctionHouseFrame
  if f and f:IsShown() and f.SearchBar and f.SearchBar.SearchBox then
    pcall(function()
      if f.SetDisplayMode and AuctionHouseFrameDisplayMode then f:SetDisplayMode(AuctionHouseFrameDisplayMode.Buy) end
      f.SearchBar.SearchBox:SetText(name)
      f.SearchBar:StartSearch()
    end)
    return true
  elseif BrowseName and AuctionFrameBrowse_Search then   -- older auction house interface
    BrowseName:SetText(name); pcall(AuctionFrameBrowse_Search)
    return true
  end
  return false
end

-- ---------------------------------------------------------------- window
function FT:BuildUI()
  local f = CreateFrame("Frame", "ForeverTradesFrame", UIParent, "BasicFrameTemplateWithInset")
  f:SetSize(WIDTH, HEIGHT)
  f:SetPoint("CENTER")
  f:SetFrameStrata("HIGH")
  f:SetMovable(true); f:EnableMouse(true); f:SetClampedToScreen(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", function(self) self:StopMovingOrSizing(); db.moved = true end)
  f:Hide()
  local title = f.TitleText or f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  if not f.TitleText then title:SetPoint("TOP", 0, -5) end
  title:SetText("Forever Trades")
  self.frame = f

  f.where = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  f.where:SetPoint("TOPLEFT", 12, -30); f.where:SetPoint("RIGHT", -12, 0); f.where:SetJustifyH("LEFT")
  f.age = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  f.age:SetPoint("TOPLEFT", f.where, "BOTTOMLEFT", 0, -3); f.age:SetPoint("RIGHT", -12, 0); f.age:SetJustifyH("LEFT")

  -- live prices: status and a button to check again or stop
  f.scanBtn = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
  f.scanBtn:SetSize(96, 20); f.scanBtn:SetPoint("TOPRIGHT", f.age, "BOTTOMRIGHT", 0, -4)
  f.scanBtn:SetScript("OnClick", function() if live.busy then FT:StopLive() else FT:ScanLive() end end)
  f.liveText = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  f.liveText:SetPoint("TOPLEFT", f.age, "BOTTOMLEFT", 0, -7); f.liveText:SetPoint("RIGHT", f.scanBtn, "LEFT", -6, 0)
  f.liveText:SetJustifyH("LEFT")

  -- "This auction house is: Alliance | Blackwater" (the zone list may not know every client language)
  f.isHome = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
  f.isHome:SetSize(110, 20); f.isHome:SetPoint("TOPLEFT", f.liveText, "BOTTOMLEFT", 0, -10)
  f.isHome:SetScript("OnClick", function() FT:SetOverride(faction()) end)
  f.isNeutral = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
  f.isNeutral:SetSize(110, 20); f.isNeutral:SetPoint("LEFT", f.isHome, "RIGHT", 6, 0)
  f.isNeutral:SetText("Blackwater")
  f.isNeutral:SetScript("OnClick", function() FT:SetOverride("neutral") end)

  f.hide = CreateFrame("CheckButton", nil, f, "UICheckButtonTemplate")
  f.hide:SetSize(22, 22); f.hide:SetPoint("TOPLEFT", f.isHome, "BOTTOMLEFT", -2, -4)
  f.hide:SetScript("OnClick", function(self) db.hideSelling = self:GetChecked() and true or false; FT:Refresh() end)
  f.hideText = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  f.hideText:SetPoint("LEFT", f.hide, "RIGHT", 2, 0); f.hideText:SetPoint("RIGHT", f, "RIGHT", -12, 0); f.hideText:SetJustifyH("LEFT")

  local scroll = CreateFrame("ScrollFrame", nil, f, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", f.hide, "BOTTOMLEFT", 2, -4)
  scroll:SetPoint("BOTTOMRIGHT", -30, 10)
  local content = CreateFrame("Frame", nil, scroll)
  content:SetSize(WIDTH - 50, 10)
  scroll:SetScrollChild(content)
  f.scroll, f.content = scroll, content
  f.rows, f.heads = {}, {}
end

local function headAt(f, k)
  local h = f.heads[k]
  if not h then
    h = f.content:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    h:SetJustifyH("LEFT"); h:SetWidth(WIDTH - 54)
    f.heads[k] = h
  end
  h:Show()
  return h
end

local function rowAt(f, k)
  local r = f.rows[k]
  if not r then
    r = CreateFrame("Button", nil, f.content)
    r:SetSize(WIDTH - 54, ROW_H)
    r:RegisterForClicks("LeftButtonUp")
    r.hl = r:CreateTexture(nil, "HIGHLIGHT"); r.hl:SetAllPoints(); r.hl:SetColorTexture(1, 0.82, 0, 0.08)
    r.name = r:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    r.name:SetPoint("TOPLEFT", 2, -2); r.name:SetPoint("RIGHT", -2, 0); r.name:SetJustifyH("LEFT")
    local prev = r.name
    for _, key in ipairs({ "live", "l1", "l2", "l3" }) do
      local fs = r:CreateFontString(nil, "OVERLAY", key == "l3" and "GameFontDisableSmall" or "GameFontHighlightSmall")
      fs:SetPoint("TOPLEFT", prev, "BOTTOMLEFT", 0, -1); fs:SetPoint("RIGHT", -2, 0); fs:SetJustifyH("LEFT")
      r[key], prev = fs, fs
    end
    for _, fs in ipairs({ r.name, r.live, r.l1, r.l2, r.l3 }) do if fs.SetWordWrap then fs:SetWordWrap(false) end end
    r:SetScript("OnEnter", function(self)
      GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
      if GameTooltip.SetItemByID then GameTooltip:SetItemByID(self.o.id) else GameTooltip:SetHyperlink("item:" .. self.o.id) end
      GameTooltip:AddLine(" ")
      GameTooltip:AddLine(self.buyHere and "Click: search for it here" or "Buy it in the other house, then sell it here", 0.6, 0.8, 1)
      GameTooltip:AddLine("Shift-click: link it in chat", 0.6, 0.8, 1)
      GameTooltip:Show()
    end)
    r:SetScript("OnLeave", function() GameTooltip:Hide() end)
    r:SetScript("OnClick", function(self)
      local _, link = itemInfo(self.o.id)
      if IsShiftKeyDown() and link and ChatEdit_InsertLink then ChatEdit_InsertLink(link); return end
      if not searchFor(self.o.name) then print("|cffffd100Forever Trades:|r open the auction house to search for " .. self.o.name) end
    end)
    f.rows[k] = r
  end
  r:Show()
  return r
end

function FT:SetOverride(house)
  local zone = GetRealZoneText and GetRealZoneText() or ""
  db.override[zone] = (house ~= L.HouseFor(zone, GetSubZoneText and GetSubZoneText(), faction(), nil)) and house or nil
  state.house = house
  self:RequestOwned()
  if state.atAH then self:ScanLive() end
  self:Refresh()
end

local function liveStatus()
  if not state.atAH then return "Live prices: open an auction house to check them", "Check" end
  if live.busy then
    if live.mode == "replicate" and not live.reading then return "Reading this auction house…", "Stop" end
    if live.mode == "replicate" then return "Reading this auction house: " .. live.done .. " of " .. live.total .. " listings", "Stop" end
    return "Checking prices here: " .. live.done .. " of " .. live.total .. " items", "Stop"
  end
  if live.t and live.house == state.house then
    local n = 0
    for _ in pairs(live.checked) do n = n + 1 end
    return "|cff80ff80Live prices from here, " .. date("%H:%M", live.t) .. "|r (" .. n .. " items checked)", "Check again"
  end
  return live.stopped and "Live check stopped: showing the website's prices" or "Live prices: not checked yet", "Check prices"
end

function FT:Refresh()
  local f = self.frame
  if not f or not f:IsShown() then return end
  local data, fac = ForeverTradesData, faction()
  local house = state.house or fac
  local home = L.FACTION_NAME[fac] or "Home"
  f.isHome:SetText(home)
  local here = (house == "neutral") and "Blackwater" or ("the " .. L.HouseName(house, fac))
  f.where:SetText(state.atAH and ("At " .. here) or ("Lists for " .. here .. " (open an auction house to read your listings)"))
  local lt, bt = liveStatus()
  f.liveText:SetText(lt); f.scanBtn:SetText(bt)
  if not data or not data[fac] then
    f.age:SetText("|cffff6060No price data. Run UpdateData in the addon's folder, then type /reload.|r")
    return
  end
  local ageText, hours = L.Age(time(), data.generated)
  f.age:SetText((hours > 3 and "|cffff8040" or "") .. "Other house and sales: the website's, " .. ageText .. (hours > 3 and ": run UpdateData and /reload|r" or ""))

  local mine = db.owned[charKey()] or {}
  local selling = L.Selling(mine, time())
  local nSelling = 0
  for _ in pairs(selling) do nSelling = nSelling + 1 end
  f.hide:SetChecked(db.hideSelling)

  for _, h in pairs(f.heads) do h:Hide() end
  for _, r in pairs(f.rows) do r:Hide() end
  local y, nh, nr, hiddenTotal = 0, 0, 0, 0
  for _, sec in ipairs(L.Sections(data, fac, house)) do
    local items = {}
    for _, o in ipairs(sec.items) do items[#items + 1] = L.Relive(o, sec.buyHere, house, liveFor(o.id)) end
    L.SortLive(items)
    local shown, hidden = L.Filter(items, selling, db.hideSelling)
    hiddenTotal = hiddenTotal + #hidden
    local paying = 0
    for _, o in ipairs(shown) do if o.pays ~= false then paying = paying + 1 end end
    nh = nh + 1
    local h = headAt(f, nh)
    h:ClearAllPoints(); h:SetPoint("TOPLEFT", f.content, "TOPLEFT", 0, -y)
    h:SetText(sec.title .. "  |cff999999(" .. paying .. (paying ~= #shown and (" + " .. (#shown - paying) .. " that no longer pay") or "") .. ")|r")
    y = y + 20
    for _, o in ipairs(shown) do
      nr = nr + 1
      local r = rowAt(f, nr)
      r.o, r.buyHere = o, sec.buyHere
      r:ClearAllPoints(); r:SetPoint("TOPLEFT", f.content, "TOPLEFT", 0, -y)
      local _, _, q = itemInfo(o.id)
      local inBags = bagCount(o.id)
      local tag = ""
      if selling[o.id] then tag = tag .. "  |cffffd100(you're selling " .. selling[o.id] .. ")|r" end
      if inBags > 0 then tag = tag .. "  |cff80ff80(" .. inBags .. " in your bags)|r" end
      r.name:SetText(qualityColor(q or o.q) .. o.name .. "|r" .. tag)
      if o.live then
        r.live:SetText((o.pays == false and "|cffff8040" or "|cff80ff80") .. o.live .. (o.pays == false and ": doesn't pay now" or "") .. "|r")
      else
        r.live:SetText("|cff999999Not checked here yet: the website's prices|r")
      end
      local a, b, c = L.Lines(o)
      r.l1:SetText(a); r.l2:SetText(b); r.l3:SetText(c)
      r:SetAlpha(o.pays == false and 0.55 or 1)
      y = y + ROW_H + 2
    end
    if #shown == 0 then
      nh = nh + 1
      local e = headAt(f, nh)
      e:ClearAllPoints(); e:SetPoint("TOPLEFT", f.content, "TOPLEFT", 6, -y)
      e:SetText("|cff999999Nothing right now.|r")
      y = y + 18
    end
    y = y + 8
  end
  f.content:SetHeight(math.max(y, 10))
  if state.atAH and not state.scanned then
    f.hideText:SetText("Hide what I'm already selling (reading your listings…)")
  else
    f.hideText:SetText("Hide what I'm already selling (" .. nSelling .. (nSelling == 1 and " item" or " items") .. (hiddenTotal > 0 and (", " .. hiddenTotal .. " hidden") or "") .. ")")
  end
end

function FT:Open()
  if not self.frame then self:BuildUI() end
  local f = self.frame
  if not db.moved then
    f:ClearAllPoints()
    if AuctionHouseFrame and AuctionHouseFrame:IsShown() then f:SetPoint("TOPLEFT", AuctionHouseFrame, "TOPRIGHT", 4, 0)
    elseif AuctionFrame and AuctionFrame:IsShown() then f:SetPoint("TOPLEFT", AuctionFrame, "TOPRIGHT", 4, -12)
    else f:SetPoint("CENTER") end
  end
  f:Show()
  self:Refresh()
end

-- ---------------------------------------------------------------- events
local function onEvent(self, event, arg1)
  if event == "ADDON_LOADED" and arg1 == "ForeverTrades" then
    ForeverTradesDB = ForeverTradesDB or {}
    db = ForeverTradesDB
    db.owned = db.owned or {}
    db.override = db.override or {}
    if db.hideSelling == nil then db.hideSelling = true end
  elseif event == "AUCTION_HOUSE_SHOW" then
    local zone = GetRealZoneText and GetRealZoneText() or ""
    state.house = L.HouseFor(zone, GetSubZoneText and GetSubZoneText(), faction(), db.override[zone])
    state.atAH, state.scanned = true, false
    FT:Open()
    FT:RequestOwned()
    if live.house ~= state.house or not live.t or time() - live.t > 10 * 60 then
      after(1.5, function() if state.atAH and not live.busy then FT:ScanLive() end end)
    end
  elseif event == "AUCTION_HOUSE_CLOSED" then
    state.atAH = false
    if live.busy then live.busy = false; live.mode = nil; live.pending = nil end
    if FT.frame then FT.frame:Hide() end
  elseif event == "OWNED_AUCTIONS_UPDATED" or event == "AUCTION_OWNED_LIST_UPDATE" then
    if state.atAH then FT:StoreOwned() end
  elseif event == "AUCTION_HOUSE_AUCTION_CREATED" or event == "AUCTION_CANCELED" then
    if state.atAH then FT:RequestOwned() end
  elseif event == "REPLICATE_ITEM_LIST_UPDATE" then
    if live.busy and live.mode == "replicate" then FT:ReadReplicate() end
  elseif event == "COMMODITY_SEARCH_RESULTS_UPDATED" then
    FT:CommodityResults(arg1)
  elseif event == "ITEM_SEARCH_RESULTS_UPDATED" then
    FT:ItemResults(arg1)
  elseif event == "AUCTION_HOUSE_THROTTLED_SYSTEM_READY" then
    if live.busy and live.mode == "search" then FT:NextSearch() end
  elseif event == "BAG_UPDATE_DELAYED" then
    FT:Refresh()
  end
end

FT:SetScript("OnEvent", onEvent)
for _, e in ipairs({ "ADDON_LOADED", "AUCTION_HOUSE_SHOW", "AUCTION_HOUSE_CLOSED", "OWNED_AUCTIONS_UPDATED",
                     "AUCTION_OWNED_LIST_UPDATE", "AUCTION_HOUSE_AUCTION_CREATED", "AUCTION_CANCELED", "BAG_UPDATE_DELAYED",
                     "REPLICATE_ITEM_LIST_UPDATE", "COMMODITY_SEARCH_RESULTS_UPDATED", "ITEM_SEARCH_RESULTS_UPDATED",
                     "AUCTION_HOUSE_THROTTLED_SYSTEM_READY" }) do
  pcall(FT.RegisterEvent, FT, e)                        -- an event this client doesn't have is skipped
end

SLASH_FOREVERTRADES1, SLASH_FOREVERTRADES2 = "/ft", "/forevertrades"
SlashCmdList.FOREVERTRADES = function(msg)
  msg = (msg or ""):lower()
  if msg == "reset" then
    db.owned, db.override, db.moved, db.lastReplicate = {}, {}, nil, nil
    print("|cffffd100Forever Trades:|r forgot your stored listings, house choices and window position.")
    if FT.frame then FT.frame:ClearAllPoints(); FT.frame:SetPoint("CENTER") end
    return
  end
  if msg == "scan" then FT:ScanLive(); return end
  if FT.frame and FT.frame:IsShown() and msg == "" then FT.frame:Hide(); return end
  if not state.atAH then state.house = (msg == "blackwater" or msg == "neutral") and "neutral" or faction() end
  FT:Open()
end
