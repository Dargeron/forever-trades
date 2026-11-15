-- Forever Trades: shows the website's cross-faction trades at the auction house, from where you stand
-- (Blackwater or your faction's house), leaving out what you already have listed. The prices come from
-- ForeverTrades_Data.lua (run UpdateData to refresh it, then /reload); your listings are read in game.

local L = ForeverTradesLogic
local FT = CreateFrame("Frame", "ForeverTradesEvents")
ForeverTrades = FT

local ROW_H, WIDTH, HEIGHT = 54, 420, 560
local db                                                -- ForeverTradesDB (saved per account)
local state = { house = nil, atAH = false, scanned = false }

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

-- ---------------------------------------------------------------- searching the auction house
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

  -- "This auction house is: Alliance | Blackwater" (the zone list may not know every client language)
  f.isHome = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
  f.isHome:SetSize(110, 20); f.isHome:SetPoint("TOPLEFT", f.age, "BOTTOMLEFT", 0, -6)
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
    r.l1 = r:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    r.l1:SetPoint("TOPLEFT", r.name, "BOTTOMLEFT", 0, -1); r.l1:SetPoint("RIGHT", -2, 0); r.l1:SetJustifyH("LEFT")
    r.l2 = r:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    r.l2:SetPoint("TOPLEFT", r.l1, "BOTTOMLEFT", 0, -1); r.l2:SetPoint("RIGHT", -2, 0); r.l2:SetJustifyH("LEFT")
    r.l3 = r:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
    r.l3:SetPoint("TOPLEFT", r.l2, "BOTTOMLEFT", 0, -1); r.l3:SetPoint("RIGHT", -2, 0); r.l3:SetJustifyH("LEFT")
    for _, fs in ipairs({ r.name, r.l1, r.l2, r.l3 }) do if fs.SetWordWrap then fs:SetWordWrap(false) end end
    r:SetScript("OnEnter", function(self)
      GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
      if GameTooltip.SetItemByID then GameTooltip:SetItemByID(self.o.id) else GameTooltip:SetHyperlink("item:" .. self.o.id) end
      GameTooltip:AddLine(" ")
      GameTooltip:AddLine(self.buyHere and "Click: search for it here" or "Buy it in the other house", 0.6, 0.8, 1)
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
  self:Refresh()
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
  if not data or not data[fac] then
    f.age:SetText("|cffff6060No price data. Run UpdateData in the addon's folder, then type /reload.|r")
    return
  end
  local ageText, hours = L.Age(time(), data.generated)
  f.age:SetText((hours > 3 and "|cffff8040" or "") .. "Prices from the website, " .. ageText .. (hours > 3 and ": run UpdateData and /reload|r" or ""))

  local mine = db.owned[charKey()] or {}
  local selling = L.Selling(mine, time())
  local nSelling = 0
  for _ in pairs(selling) do nSelling = nSelling + 1 end
  f.hide:SetChecked(db.hideSelling)

  for _, h in pairs(f.heads) do h:Hide() end
  for _, r in pairs(f.rows) do r:Hide() end
  local y, nh, nr, hiddenTotal = 0, 0, 0, 0
  for _, sec in ipairs(L.Sections(data, fac, house)) do
    local shown, hidden = L.Filter(sec.items, selling, db.hideSelling)
    hiddenTotal = hiddenTotal + #hidden
    nh = nh + 1
    local h = headAt(f, nh)
    h:ClearAllPoints(); h:SetPoint("TOPLEFT", f.content, "TOPLEFT", 0, -y)
    h:SetText(sec.title .. "  |cff999999(" .. #shown .. ")|r")
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
      local a, b, c = L.Lines(o)
      r.l1:SetText(a); r.l2:SetText(b); r.l3:SetText(c)
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
  elseif event == "AUCTION_HOUSE_CLOSED" then
    state.atAH = false
    if FT.frame then FT.frame:Hide() end
  elseif event == "OWNED_AUCTIONS_UPDATED" or event == "AUCTION_OWNED_LIST_UPDATE" then
    if state.atAH then FT:StoreOwned() end
  elseif event == "AUCTION_HOUSE_AUCTION_CREATED" or event == "AUCTION_CANCELED" then
    if state.atAH then FT:RequestOwned() end
  elseif event == "BAG_UPDATE_DELAYED" then
    FT:Refresh()
  end
end

FT:SetScript("OnEvent", onEvent)
for _, e in ipairs({ "ADDON_LOADED", "AUCTION_HOUSE_SHOW", "AUCTION_HOUSE_CLOSED", "OWNED_AUCTIONS_UPDATED",
                     "AUCTION_OWNED_LIST_UPDATE", "AUCTION_HOUSE_AUCTION_CREATED", "AUCTION_CANCELED", "BAG_UPDATE_DELAYED" }) do
  pcall(FT.RegisterEvent, FT, e)                        -- an event this client doesn't have is skipped
end

SLASH_FOREVERTRADES1, SLASH_FOREVERTRADES2 = "/ft", "/forevertrades"
SlashCmdList.FOREVERTRADES = function(msg)
  msg = (msg or ""):lower()
  if msg == "reset" then
    db.owned, db.override, db.moved = {}, {}, nil
    print("|cffffd100Forever Trades:|r forgot your stored listings, house choices and window position.")
    if FT.frame then FT.frame:ClearAllPoints(); FT.frame:SetPoint("CENTER") end
    return
  end
  if FT.frame and FT.frame:IsShown() and msg == "" then FT.frame:Hide(); return end
  if not state.atAH then state.house = (msg == "blackwater" or msg == "neutral") and "neutral" or faction() end
  FT:Open()
end
