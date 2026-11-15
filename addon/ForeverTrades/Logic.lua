-- Forever Trades: the addon's logic, with no game API calls, so tools/addon_test.py can test it outside the game.
-- ForeverTradesData comes from ForeverTrades_Data.lua, written every hour by the website's update job.

ForeverTradesLogic = {}
local L = ForeverTradesLogic

-- Zones whose auction house is Blackwater (the neutral one): Booty Bay, Gadgetzan, Everlook and their zones,
-- in English, Spanish, German and French clients. Anything else is your own faction's house. The window
-- also has a switch, for a client language or a new auction house this list doesn't know.
L.NEUTRAL_ZONES = {
  ["Booty Bay"] = true, ["Gadgetzan"] = true, ["Everlook"] = true,
  ["Stranglethorn Vale"] = true, ["Tanaris"] = true, ["Winterspring"] = true,
  ["Bahía del Botín"] = true, ["Vista Eterna"] = true, ["Cuna del Invierno"] = true, ["Vega de Tuercespina"] = true,
  ["Beutebucht"] = true, ["Ewige Warte"] = true, ["Winterquell"] = true, ["Schlingendorntal"] = true,
  ["Baie-du-Butin"] = true, ["Long-guet"] = true, ["Berceau-de-l'Hiver"] = true, ["Vallée de Strangleronce"] = true,
}

L.FACTION_NAME = { alliance = "Alliance", horde = "Horde" }

-- Which house the player is at: "neutral" (Blackwater) or their faction ("alliance" / "horde").
function L.HouseFor(zone, subzone, faction, override)
  if override == "neutral" or override == faction then return override end
  if (subzone and L.NEUTRAL_ZONES[subzone]) or (zone and L.NEUTRAL_ZONES[zone]) then return "neutral" end
  return faction
end

local function houseName(house, faction)
  if house == "neutral" then return "Blackwater" end
  return (L.FACTION_NAME[faction] or "your faction's") .. " house"
end
L.HouseName = houseName

-- The two lists to show at a house, phrased from where you stand. Each faction's data has:
--   toHome    = buy on Blackwater, sell in your faction's house   (the site's "Buy on Blackwater -> sell at home")
--   toNeutral = buy in your faction's house, sell on Blackwater   (the site's "Buy at home -> sell on Blackwater")
function L.Sections(data, faction, house)
  local f = data and data[faction]
  if not f then return {} end
  local home = houseName(faction, faction)
  if house == "neutral" then
    return {
      { key = "toHome", buyHere = true, title = "Buy here now, sell in the " .. home, items = f.toHome or {} },
      { key = "toNeutral", buyHere = false, title = "Buy in the " .. home .. ", sell here", items = f.toNeutral or {} },
    }
  end
  return {
    { key = "toNeutral", buyHere = true, title = "Buy here now, sell on Blackwater", items = f.toNeutral or {} },
    { key = "toHome", buyHere = false, title = "Buy on Blackwater, sell here", items = f.toHome or {} },
  }
end

-- Everything you're already selling: this house's listings now, plus the other house's from your last visit
-- there (listings last at most a day, so older records are ignored). owned[house] = { t = time, items = {[id] = qty} }
function L.Selling(owned, now, maxAge)
  local set = {}
  for house, rec in pairs(owned or {}) do
    if rec and rec.items and (not rec.t or not now or now - rec.t <= (maxAge or 48 * 3600)) then
      for id, qty in pairs(rec.items) do set[id] = (set[id] or 0) + qty end
    end
  end
  return set
end

-- Split a list into what to show and what you're already selling. Keeps the site's order (profit a day).
function L.Filter(items, selling, hideSelling)
  local shown, hidden = {}, {}
  for _, o in ipairs(items or {}) do
    if selling[o.id] and hideSelling then hidden[#hidden + 1] = o else shown[#shown + 1] = o end
  end
  return shown, hidden
end

-- Money in gold, silver and copper, like the site: copper only under 10s, gold only from 100g.
function L.Money(c)
  if not c then return "-" end
  local neg = c < 0
  if neg then c = -c end
  c = math.floor(c + 0.5)
  local g, s, k = math.floor(c / 10000), math.floor(c / 100) % 100, c % 100
  local G, S, C = "|cffffd100g|r", "|cffc7c7cfs|r", "|cffeda55fc|r"
  local t
  if g >= 100 then t = g .. G
  elseif g > 0 then t = (s > 0) and (g .. G .. " " .. s .. S) or (g .. G)
  elseif c >= 1000 then t = math.floor(c / 100 + 0.5) .. S
  elseif s > 0 then t = (k > 0) and (s .. S .. " " .. k .. C) or (s .. S)
  else t = k .. C end
  return (neg and "-" or "") .. t
end

function L.Number(x)
  if not x then return "-" end
  if x >= 100 then return tostring(math.floor(x + 0.5)) end
  return tostring(math.floor(x * 10 + 0.5) / 10)
end

-- "2 h 5 min ago"; second value: hours, for the stale-data warning.
function L.Age(now, then_)
  if not now or not then_ then return "unknown", 0 end
  local m = math.floor((now - then_) / 60 + 0.5)
  if m < 1 then return "just now", 0 end
  if m < 60 then return m .. " min ago", m / 60 end
  if m < 48 * 60 then return math.floor(m / 60) .. " h " .. (m % 60) .. " min ago", m / 60 end
  return math.floor(m / 1440) .. " days ago", m / 60
end

-- One recommendation as three short lines: prices, profit per item, and how much sells.
function L.Lines(o)
  local first = "Buy up to " .. L.Money(o.buy) .. ", sell at " .. L.Money(o.sell) .. "   x" .. string.format("%.2f", o.mult or 0)
  local second = "+" .. L.Money(o.each) .. " each"
  if o.exp and o.exp ~= o.each then
    second = second .. ", " .. (o.exp < 0 and "" or "+") .. L.Money(o.exp) .. " after the deposit"
  end
  local third = o.sold and (L.Number(o.sold) .. " sold a day") or "sales: still collecting"
  if o.day then third = third .. " · +" .. L.Money(o.day) .. " a day" end
  if o.units and o.units >= 1 then third = third .. " · buy up to " .. math.floor(o.units) .. " a day" end
  return first, second, third
end

-- Re-price one trade with what the auction house you're standing at lists right now (fresher than the website).
-- live: { low = cheapest unit price here now (not yours), qty = units listed } ; false = checked, none listed ;
-- nil = not checked yet (the website's figures stand).
--   buy here:  the cheapest listing here is your buy price; what you get back in the other house stays.
--   sell here: the cheapest listing here is your competition: you sell at the lower of it and the price
--              ceiling from the website (`top`: the recent typical price at home, or half the other faction's
--              price on Blackwater).
function L.Relive(o, buyHere, house, live)
  if live == nil then return o end
  local r = {}
  for k, v in pairs(o) do r[k] = v end
  if buyHere then
    if live then
      r.buy = live.low
      r.each = o.back - live.low
      r.mult = o.back / live.low
      r.live = "Here now: " .. L.Money(live.low) .. " each, " .. live.qty .. " listed"
    else
      r.gone, r.live = true, "None listed here right now"
    end
  else
    local cut = (house == "neutral") and 0.15 or 0.05
    local top = o.top or o.sell
    local sell = live and math.min(top, live.low) or top
    r.sell = sell
    r.back = sell * (1 - cut)
    r.each = r.back - o.buy
    r.mult = r.back / o.buy
    r.live = live and ("Cheapest here now: " .. L.Money(live.low) .. ", " .. live.qty .. " listed") or "None listed here now: no competition"
  end
  if r.each then
    r.exp = r.each - (o.dep or 0)
    r.day = o.units and (o.units * r.each) or nil
  end
  r.pays = (not r.gone) and (r.mult or 0) >= 1.15
  return r
end

-- Trades that still pay first, by profit a day, then profit per item (the site's order).
function L.SortLive(list)
  table.sort(list, function(a, b)
    local pa, pb = a.pays ~= false, b.pays ~= false
    if pa ~= pb then return pa end
    local da, dbb = a.day or -1e15, b.day or -1e15
    if da ~= dbb then return da > dbb end
    return (a.each or 0) > (b.each or 0)
  end)
  return list
end
