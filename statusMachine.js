// Внутренняя статусная цепочка заказа (не путать с "сырым" статусом Kaspi —
// тот хранится отдельно в kaspi_status, просто для справки).
//
// Цепочка: preorder -> packing -> label_printed -> ready -> shipped
// Особый статус: cancelled — можно попасть из любого активного состояния.
//
// Обычному переходу разрешено идти только на следующий шаг вперёд.
// Прыжок через несколько шагов (например preorder -> shipped) — только
// через "исправление статуса" администратором с обязательной причиной.

export const STATUSES = ["preorder", "packing", "label_printed", "ready", "shipped", "cancelled"];

export const STATUS_LABELS = {
  preorder: "Предзаказ",
  packing: "Упаковка",
  label_printed: "Этикетка распечатана",
  ready: "Готов к отгрузке",
  shipped: "Отгружен",
  cancelled: "Отменён"
};

const NEXT_STEP = {
  preorder: "packing",
  packing: "label_printed",
  label_printed: "ready",
  ready: "shipped",
  shipped: null,
  cancelled: null
};

export function isValidNormalTransition(from, to) {
  if (to === "cancelled") {
    // отменить можно из любого активного (не финального) статуса
    return from !== "shipped" && from !== "cancelled";
  }
  return NEXT_STEP[from] === to;
}

export function getNextStatus(from) {
  return NEXT_STEP[from] || null;
}

// Роль, которой разрешён обычный (не административный) переход
export function roleCanTransition(role) {
  return role === "admin" || role === "warehouse";
}
