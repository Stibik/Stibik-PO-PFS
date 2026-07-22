// Модуль интеграции с API «Магазин на Kaspi.kz».
// Основано на официальной документации: https://guide.kaspi.kz/partner/ru/shop/api/orders/
// ПРОВЕРЕНО на реальном токене. Kaspi требует обязательный фильтр по дате создания заказа
// (creationDate), формат — epoch-миллисекунды. МАКСИМАЛЬНАЯ разница между $ge и $le — 14 дней
// (при попытке взять больше — ответ 400 "Exceeded the maximum difference... max [14]").

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

// Приводим ответ Kaspi (JSON:API) к нашей внутренней структуре заказа.
// Поля attributes могут отличаться — сверьте с реальным ответом API при первом подключении.
// productName — если Kaspi не отдаёт его прямо в заказе, понадобится отдельный запрос
// к товарам заказа (в документации это "получить информацию о товарах в моём заказе") —
// это НЕ реализовано здесь, добавим на следующем шаге, если понадобится.
export function mapKaspiOrder(raw, shopName) {
  const a = raw.attributes || {};
  return {
    kaspiOrderId: raw.id,
    kaspiCode: a.code || "",
    shop: shopName,
    status: a.state || a.status || "",
    orderDate: a.creationDate ? new Date(a.creationDate).toISOString().slice(0, 10) : "",
    totalPrice: a.totalPrice || 0,
    deliveryMode: a.deliveryMode || "",
    courierHandoverDate: a.plannedDeliveryDate
      ? new Date(a.plannedDeliveryDate).toISOString().slice(0, 10)
      : (a.deliveryDate ? new Date(a.deliveryDate).toISOString().slice(0, 10) : ""),
    productName: a.productName || "",
    raw: a
  };
}

export async function syncShop(token, shopName) {
  const items = await fetchShopOrders(token, { pageNumber: 0, pageSize: 100 });
  return items.map(item => mapKaspiOrder(item, shopName));
}
