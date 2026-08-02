import express from "express";
import { db } from "../db.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission("prices")); // деньги компании — не для всех

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v) { return Math.round(num(v) * 100) / 100; }
function dateOnly(v) { const s = String(v || ""); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; }
function shiftDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Что считать продажей: заказ, который не отменён и не возвращён.
// Kaspi отдаёт статусы отдельным полем, ручные УД-заказы ими не размечены.
const CANCELLED = ["CANCELLED", "CANCELLING", "RETURNED", "RETURN_REQUESTED"];

function loadOrders(from, to, shop) {
  const where = ["(o.created_at >= ? AND o.created_at <= ?)"];
  const params = [from + "T00:00:00", to + "T23:59:59"];
  if (shop) { where.push("o.shop = ?"); params.push(shop); }
  const rows = db.prepare(`SELECT * FROM orders o WHERE ${where.join(" AND ")}`).all(...params);
  return rows.filter(o => !CANCELLED.includes(String(o.kaspi_status || "")) && o.status !== "cancelled");
}

// Себестоимость и расценка берутся из Справочника по артикулу.
// Если товар не заведён — считаем по нулю и отдельно показываем, сколько таких:
// иначе прибыль будет красивой, но неправдой.
function catalogIndex() {
  const map = new Map();
  for (const it of db.prepare("SELECT article, name, cost, retail, labor_rate, material_cost FROM price_items WHERE article IS NOT NULL").all()) {
    map.set(String(it.article).trim(), it);
  }
  return map;
}

function orderArticle(o) {
  if (o.article) return String(o.article).trim();
  try {
    const code = JSON.parse(o.raw || "null")?.entries?.[0]?.offer?.code;
    if (code) return String(code).trim();
  } catch (e) {}
  return "";
}

function summarize(orders, cat) {
  let revenue = 0, cost = 0, labor = 0, units = 0, unknown = 0;
  const byShop = new Map();
  const byProduct = new Map();
  const byDay = new Map();

  for (const o of orders) {
    const qty = num(o.qty) || 1;
    const sum = num(o.total_price);
    const art = orderArticle(o);
    const item = art ? cat.get(art) : null;
    const c = item ? num(item.cost) * qty : 0;
    const l = item ? num(item.labor_rate) * qty : 0;
    if (!item) unknown++;

    revenue += sum; cost += c; labor += l; units += qty;

    const shop = o.shop || "без магазина";
    if (!byShop.has(shop)) byShop.set(shop, { shop, orders: 0, units: 0, revenue: 0, cost: 0, labor: 0 });
    const s = byShop.get(shop);
    s.orders++; s.units += qty; s.revenue += sum; s.cost += c; s.labor += l;

    const key = art || String(o.product_name || o.name || "—");
    if (!byProduct.has(key)) byProduct.set(key, {
      article: art, name: o.product_name || o.name || (item ? item.name : "") || "—",
      orders: 0, units: 0, revenue: 0, profit: 0
    });
    const p = byProduct.get(key);
    p.orders++; p.units += qty; p.revenue += sum; p.profit += sum - c - l;

    const day = dateOnly(o.created_at);
    if (day) byDay.set(day, r2((byDay.get(day) || 0) + sum));
  }

  const profit = revenue - cost - labor;
  return {
    revenue: r2(revenue), cost: r2(cost), labor: r2(labor), profit: r2(profit),
    margin: revenue ? Math.round(profit / revenue * 100) : 0,
    orders: orders.length, units: r2(units), unknownItems: unknown,
    byShop: Array.from(byShop.values()).map(s => ({
      ...s, revenue: r2(s.revenue), cost: r2(s.cost), labor: r2(s.labor),
      profit: r2(s.revenue - s.cost - s.labor)
    })).sort((a, b) => b.revenue - a.revenue),
    byProduct: Array.from(byProduct.values()).map(p => ({ ...p, revenue: r2(p.revenue), profit: r2(p.profit) })),
    byDay: Array.from(byDay.entries()).sort().map(([date, sum]) => ({ date, sum }))
  };
}

router.get("/", (req, res) => {
  const to = dateOnly(req.query.to) || new Date().toISOString().slice(0, 10);
  const from = dateOnly(req.query.from) || shiftDays(to, -29);
  const shop = req.query.shop || null;

  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  const prevTo = shiftDays(from, -1);
  const prevFrom = shiftDays(prevTo, -(days - 1));

  const cat = catalogIndex();
  const cur = summarize(loadOrders(from, to, shop), cat);
  const prev = summarize(loadOrders(prevFrom, prevTo, shop), cat);

  const delta = (a, b) => b ? Math.round((a - b) / b * 100) : (a ? 100 : 0);

  // Топ товаров и «товар периода» — по выручке
  const top = cur.byProduct.slice().sort((a, b) => b.revenue - a.revenue);
  const topByUnits = cur.byProduct.slice().sort((a, b) => b.units - a.units);

  // Сколько шить на запас: смотрим темп продаж и что уже лежит на складе.
  // Считаем на 30 дней вперёд — это подсказка, а не приказ.
  const stock = new Map();
  for (const s of db.prepare("SELECT article, SUM(qty) AS q FROM warehouse_stock WHERE consumed = 0 GROUP BY article").all()) {
    if (s.article) stock.set(String(s.article).trim(), num(s.q));
  }
  const restock = topByUnits.filter(p => p.article).map(p => {
    const perDay = p.units / days;
    const need30 = Math.ceil(perDay * 30);
    const have = stock.get(p.article) || 0;
    const item = cat.get(p.article);
    return {
      article: p.article, name: p.name, soldUnits: p.units, perMonth: need30, inStock: have,
      toMake: Math.max(0, need30 - have),
      laborRate: item ? num(item.labor_rate) : 0
    };
  }).filter(x => x.toMake > 0).slice(0, 15);

  // Зарплата за период — отдельно от расчётной, это уже реальные начисления
  const payroll = db.prepare(`SELECT status, COALESCE(SUM(amount),0) AS s, COUNT(*) AS n
                              FROM payroll_entries WHERE created_at >= ? AND created_at <= ? AND status != 'cancelled'
                              GROUP BY status`).all(from + "T00:00:00", to + "T23:59:59");
  const pay = { accrued: 0, payable: 0, paid: 0, pending: 0, works: 0 };
  for (const p of payroll) {
    pay.accrued += num(p.s); pay.works += p.n;
    if (p.status === "paid") pay.paid += num(p.s);
    if (p.status === "payable") pay.payable += num(p.s);
    if (p.status === "pending") pay.pending += num(p.s);
  }

  res.json({
    period: { from, to, days, prevFrom, prevTo },
    current: cur,
    previous: { revenue: prev.revenue, profit: prev.profit, orders: prev.orders, units: prev.units },
    delta: {
      revenue: delta(cur.revenue, prev.revenue),
      profit: delta(cur.profit, prev.profit),
      orders: delta(cur.orders, prev.orders)
    },
    topProduct: top[0] || null,
    topByRevenue: top.slice(0, 10),
    topByUnits: topByUnits.slice(0, 10),
    restock,
    payroll: { accrued: r2(pay.accrued), paid: r2(pay.paid), payable: r2(pay.payable), pending: r2(pay.pending), works: pay.works },
    dataQuality: {
      ordersWithoutCatalog: cur.unknownItems,
      itemsWithoutCost: db.prepare("SELECT COUNT(*) AS n FROM price_items WHERE (cost IS NULL OR cost = 0) AND COALESCE(is_archived,0)=0").get().n,
      itemsWithoutRate: db.prepare("SELECT COUNT(*) AS n FROM price_items WHERE (labor_rate IS NULL OR labor_rate = 0) AND COALESCE(is_archived,0)=0").get().n
    }
  });
});

export default router;
