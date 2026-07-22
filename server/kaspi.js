// Модуль интеграции с API «Магазин на Kaspi.kz».
// Основано на официальной документации: https://guide.kaspi.kz/partner/ru/shop/api/orders/
// ПРОВЕРЕНО на реальном токене. Kaspi требует обязательный фильтр по дате создания заказа
// (creationDate), формат — epoch-миллисекунды. МАКСИМАЛЬНАЯ разница между $ge и $le — 14 дней.
//
// Реальный ответ показал:
// - a.status  — статус заказа (ACCEPTED_BY_MERCHANT, COMPLETED, CANCELLED, ...) — это то,
//   что нужно показывать пользователю как "Статус"
// - a.state   — скорее логистическая стадия (KASPI_DELIVERY, ARCHIVE) — показываем отдельно
// - a.preOrder — булево, это и есть "Предзаказ" из кабинета продавца
// - Названия товара В ЗАКАЗЕ НЕТ — нужен отдельный запрос к позициям заказа (entries)

const BASE_URL = "https://kaspi.kz/shop/api/v2";

export async function fetchShopOrders(token, { pageNumber = 0, pageSize = 100, daysBack = 14 } = {}) {
  const now = Date.now();
  const from = now - Math.min(daysBack, 14) * 24 * 60 * 60 * 1000;
  const url = `${BASE_URL}/orders`
    + `?page[number]=${pageNumber}&page[size]=${pageSize}`
    + `&filter[orders][creationDate][$ge]=${from}`
    + `&filter[orders][creationDate][$le]=${now}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/vnd.api+json",
      "X-Auth-Token": token
    }
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Kaspi API ответил ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = await resp.json();
  return json.data || [];
}

// Получаем позиции (товары) заказа — отдельный запрос, т.к. в самом заказе названия нет.
// Путь предположительный (по общей структуре Kaspi API) — если не сработает, вернём пусто
// и ничего не сломаем, просто останется "—" в наименовании.
export async function fetchOrderEntries(token, kaspiOrderId) {
  try {
    const url = `${BASE_URL}/orders/${kaspiOrderId}/entries?include=product`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/vnd.api+json", "X-Auth-Token": token }
    });
    if (!resp.ok) return { names: [], raw: null };
    const json = await resp.json();
    const names = [];
    if (Array.isArray(json.included)) {
      json.included.forEach(inc => {
        const n = inc.attributes?.name;
        if (n) names.push(n);
      });
    }
    if (!names.length && Array.isArray(json.data)) {
      json.data.forEach(entry => {
        const n = entry.attributes?.name || entry.attributes?.offer?.name;
        if (n) names.push(n);
      });
    }
    return { names, raw: json };
  } catch (e) {
    return { names: [], raw: null };
  }
}

export function mapKaspiOrder(raw, shopName) {
  const a = raw.attributes || {};
  return {
    kaspiOrderId: raw.id,
    kaspiCode: a.code || "",
    shop: shopName,
    status: a.status || "",
    deliveryState: a.state || "",
    preOrder: !!a.preOrder,
    orderDate: a.creationDate ? new Date(a.creationDate).toISOString().slice(0, 10) : "",
    totalPrice: a.totalPrice || 0,
    deliveryMode: a.deliveryMode || "",
    courierHandoverDate: a.plannedDeliveryDate
      ? new Date(a.plannedDeliveryDate).toISOString().slice(0, 10)
      : "",
    productName: "",
    raw: a
  };
}

export async function syncShop(token, shopName, { fetchNames = true } = {}) {
  const items = await fetchShopOrders(token, { pageNumber: 0, pageSize: 100 });
  const mapped = items.map(item => mapKaspiOrder(item, shopName));

  if (fetchNames) {
    // Подтягиваем названия товаров небольшими партиями, чтобы не перегружать API
    const BATCH = 8;
    for (let i = 0; i < mapped.length; i += BATCH) {
      const batch = mapped.slice(i, i + BATCH);
      await Promise.all(batch.map(async (o) => {
        const { names } = await fetchOrderEntries(token, o.kaspiOrderId);
        if (names.length) o.productName = names.join(", ");
      }));
    }
  }
  return mapped;
}
