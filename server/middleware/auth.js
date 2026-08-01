import { db } from "../db.js";

// Наборы прав по ролям — то, что подставляется по умолчанию при создании
// пользователя. Дальше админ галочками правит под конкретного человека.
export const ROLE_PRESETS = {
  admin:     ["prihod","orders","claims","catalog","price","salary","production","tasks","china","kaspi","audit","users","prices","payout","delete"],
  manager:   ["prihod","orders","claims","catalog","price","salary","production","tasks","china","prices","payout"],
  warehouse: ["prihod","orders","claims","catalog","production","tasks"],
  stitcher:  ["monitor"]
};

export const PERMISSIONS = [
  { key:"prihod",     label:"Приход",                group:"Разделы" },
  { key:"orders",     label:"Заказы",                group:"Разделы" },
  { key:"claims",     label:"Отмены и возвраты",     group:"Разделы" },
  { key:"catalog",    label:"Справочник",            group:"Разделы" },
  { key:"price",      label:"Прайс",                 group:"Разделы" },
  { key:"salary",     label:"Зарплата",              group:"Разделы" },
  { key:"production", label:"Производство",          group:"Разделы" },
  { key:"tasks",      label:"Задачи",                group:"Разделы" },
  { key:"china",      label:"Закупки из Китая",      group:"Разделы" },
  { key:"kaspi",      label:"Kaspi: настройки",      group:"Разделы" },
  { key:"audit",      label:"Журнал действий",       group:"Разделы" },
  { key:"users",      label:"Пользователи и права",  group:"Разделы" },
  { key:"monitor",    label:"Монитор заказов (для забивщиков)", group:"Разделы" },
  { key:"prices",     label:"Видеть закупку и маржу", group:"Что можно" },
  { key:"payout",     label:"Проводить выплаты",      group:"Что можно" },
  { key:"delete",     label:"Удалять записи",         group:"Что можно" }
];

export function permissionsOf(user) {
  if (!user) return [];
  if (user.role === "admin") return ROLE_PRESETS.admin;
  try {
    const parsed = JSON.parse(user.permissions || "null");
    if (Array.isArray(parsed)) return parsed;
  } catch (e) { /* права не заданы — берём набор по роли */ }
  return ROLE_PRESETS[user.role] || ROLE_PRESETS.warehouse;
}

export function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: "not_authenticated" });
}

export function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.role === "admin") return next();
  return res.status(403).json({ error: "admin_only", message: "Требуются права администратора" });
}

// Проверка конкретного права. Админ проходит всегда — чтобы нельзя было
// случайно снять галочку и запереть самого себя снаружи системы.
export function requirePermission(perm) {
  return function (req, res, next) {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: "not_authenticated" });
    }
    if (req.session.role === "admin") return next();
    const list = req.session.permissions || [];
    if (list.includes(perm)) return next();
    return res.status(403).json({ error: "forbidden", message: "У вас нет доступа к этому разделу" });
  };
}

export function hasPermission(req, perm) {
  if (!req.session) return false;
  if (req.session.role === "admin") return true;
  return (req.session.permissions || []).includes(perm);
}

// Сотрудник, к которому привязан пользователь — по нему падает работа и зарплата
export function currentEmployeeId(req) {
  if (!req.session || !req.session.userId) return null;
  const u = db.prepare("SELECT employee_id FROM users WHERE id = ?").get(req.session.userId);
  return u ? u.employee_id : null;
}
