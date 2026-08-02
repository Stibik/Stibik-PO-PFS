import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");

console.log(`[db] Использую путь к базе данных: ${DB_PATH}`);

// Убедимся, что папка для файла БД существует (важно для /data на Render)
const dbDir = path.dirname(DB_PATH);
try {
  if (!fs.existsSync(dbDir)) {
    console.log(`[db] Папки ${dbDir} нет, создаю...`);
    fs.mkdirSync(dbDir, { recursive: true });
  }
  console.log(`[db] Проверка доступности папки ${dbDir}: OK, содержимое:`, fs.readdirSync(dbDir));
} catch (e) {
  console.error(`[db] ОШИБКА при создании/чтении папки ${dbDir}:`, e.message);
  throw e;
}

export let db;
try {
  db = new DatabaseSync(DB_PATH);
  console.log(`[db] База данных SQLite успешно открыта: ${DB_PATH}`);
} catch (e) {
  console.error(`[db] ОШИБКА при открытии базы данных ${DB_PATH}:`, e.message, e.stack);
  throw e;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'manual',
  kaspi_order_id TEXT UNIQUE,
  kaspi_code TEXT,
  shop TEXT,
  receipt_number INTEGER,
  display_number INTEGER,
  article TEXT,
  name TEXT,
  qty REAL,
  note TEXT,
  photo TEXT,
  receive_status TEXT DEFAULT 'transit', -- 'transit'/'arrived'/'problem' — статус "Прихода" (поставка от поставщика)
  status TEXT NOT NULL DEFAULT 'preorder', -- статус обработки заказа Kaspi (сборка/отгрузка), для source='kaspi'
  kaspi_status TEXT,
  delivery_state TEXT,
  pre_order INTEGER DEFAULT 0,
  assembled INTEGER DEFAULT 0,
  courier_transmission_date TEXT,
  courier_handover_date TEXT,
  total_price REAL,
  product_name TEXT,
  waybill_url TEXT,
  printed INTEGER DEFAULT 0,
  print_count INTEGER DEFAULT 0,
  last_printed_at TEXT,
  last_printed_by TEXT,
  claim_note TEXT,
  claim_resolved INTEGER DEFAULT 0,
  raw TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  user TEXT,
  reason TEXT,
  is_correction INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS cargo_places (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  place_number INTEGER,
  name TEXT,
  formed INTEGER DEFAULT 0,
  label_printed INTEGER DEFAULT 0,
  formed_at TEXT,
  formed_by TEXT,
  comment TEXT
);

CREATE TABLE IF NOT EXISTS print_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  user TEXT,
  printed_at TEXT,
  is_reprint INTEGER DEFAULT 0,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT,
  action TEXT NOT NULL,
  order_id TEXT,
  old_value TEXT,
  new_value TEXT,
  comment TEXT,
  ip TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS price_items (
  id TEXT PRIMARY KEY,
  article TEXT,
  name TEXT,
  type TEXT,
  color TEXT,
  height REAL,
  diameter REAL,
  weight REAL,
  material TEXT,
  mount TEXT,
  buy_price_kzt REAL,
  delivery_price REAL,
  wholesale REAL,
  retail REAL,
  cost REAL,
  note TEXT,
  photo TEXT,
  photo_name TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS production (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  article TEXT,
  product_name TEXT,
  decision TEXT,              -- 'stock' | 'assigned' | 'return_offset' | NULL (пока не решено)
  employee_id TEXT,
  paid INTEGER DEFAULT 0,      -- оплачено ли исполнителю (актуально для decision='assigned')
  warehouse_stock_id TEXT,     -- если списано со склада — какая именно запись использована
  created_at TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS warehouse_stock (
  id TEXT PRIMARY KEY,
  article TEXT,
  product_name TEXT,
  source TEXT,                -- 'cancelled' | 'returned' | 'overproduced'
  source_order_id TEXT,
  qty INTEGER DEFAULT 1,
  consumed INTEGER DEFAULT 0,
  consumed_by_order_id TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS production_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  production_id TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT,
  user TEXT,
  reason TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_production_history_prod ON production_history(production_id);

CREATE INDEX IF NOT EXISTS idx_production_order ON production(order_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_article ON warehouse_stock(article);
CREATE INDEX IF NOT EXISTS idx_warehouse_consumed ON warehouse_stock(consumed);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  short_name TEXT NOT NULL,        -- краткое название (в выпадающем списке)
  full_name TEXT,                  -- полное юридическое наименование
  bin TEXT,                        -- ИИН/БИН
  address TEXT,                    -- юридический адрес
  bank_name TEXT,
  bik TEXT,
  iban TEXT,
  kbe TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  contact_person TEXT,             -- ФИО руководителя/контактного лица (необязательно)
  logo TEXT,                       -- путь к логотипу (через тот же /api/upload, что и фото товаров)
  brand_color TEXT,                -- основной цвет оформления (необязательно)
  extra_text TEXT,                 -- дополнительный текст для PDF (необязательно)
  is_active INTEGER DEFAULT 1,
  is_default INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS price_lists (
  id TEXT PRIMARY KEY,
  name TEXT,                       -- название прайса (уходит в шапку PDF)
  kind TEXT DEFAULT 'draft',       -- 'draft' — рабочий черновик пользователя, 'saved' — сохранённый прайс
  owner TEXT,                      -- логин владельца черновика (у каждого пользователя свой)
  company_id TEXT,
  settings TEXT,                   -- JSON настроек PDF
  company_snapshot TEXT,           -- JSON реквизитов на момент сохранения (только для kind='saved')
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS price_list_items (
  id TEXT PRIMARY KEY,
  price_list_id TEXT,
  item_id TEXT,                    -- ссылка на товар в price_items
  sort_order INTEGER DEFAULT 0,
  snapshot TEXT                    -- JSON товара на момент сохранения (только для kind='saved')
);

-- ---------- Контур «Китай»: контроль закупок у поставщиков ----------
-- Это НЕ продажи: сюда не заходят Kaspi-заказы, зарплата, производство и маржа.
-- Отдельные таблицы, потому что у закупки другая жизнь (заказ -> отправка ->
-- путь -> получение) и свои количества: заказано / отправлено / получено.
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,                      -- телефон или мессенджер
  link TEXT,
  comment TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS china_purchase_orders (
  id TEXT PRIMARY KEY,
  number INTEGER,                  -- внутренний номер закупки
  supplier_id TEXT,
  supplier_order_no TEXT,          -- номер заказа у поставщика
  channel TEXT,                    -- площадка/канал закупки
  order_date TEXT,
  plan_ship_date TEXT,
  fact_ship_date TEXT,
  plan_arrive_date TEXT,
  fact_receive_date TEXT,
  status TEXT DEFAULT 'ordered',   -- ordered / ready / transit / received / cancelled
  currency TEXT DEFAULT 'CNY',
  rate REAL,                       -- курс к тенге на момент закупки
  total_amount REAL DEFAULT 0,     -- считается на сервере по позициям
  track_no TEXT,                   -- трек-номер или номер карго
  link TEXT,
  comment TEXT,
  attachment TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  is_archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS china_purchase_order_items (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT,
  item_id TEXT,                    -- ссылка на price_items, если товар уже в Справочнике
  article TEXT,
  name TEXT,
  photo TEXT,
  category TEXT,
  qty_ordered REAL DEFAULT 0,
  qty_shipped REAL DEFAULT 0,
  qty_received REAL DEFAULT 0,
  unit_price REAL DEFAULT 0,
  total_price REAL DEFAULT 0,      -- считается на сервере
  comment TEXT,
  sort_order INTEGER DEFAULT 0
);

-- Склад контура «Китай»: полностью отдельный от основного склада и Справочника.
-- Сюда попадает то, что физически приехало и разложено по ячейкам.
CREATE TABLE IF NOT EXISTS china_stock (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT,          -- из какой закупки приехало
  purchase_item_id TEXT,
  article TEXT,                    -- артикул поставщика (может повторяться у разных)
  name TEXT,
  photo TEXT,
  category TEXT,
  barcode TEXT UNIQUE,             -- НАШ внутренний код, печатается на этикетке
  cell TEXT,                       -- ячейка хранения, напр. A-01-03
  qty REAL DEFAULT 0,
  unit_price REAL DEFAULT 0,
  comment TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS china_stock_moves (
  id TEXT PRIMARY KEY,
  stock_id TEXT,
  kind TEXT,                       -- receive / move / adjust / write_off / inventory
  qty_before REAL,
  qty_after REAL,
  cell_before TEXT,
  cell_after TEXT,
  comment TEXT,
  user TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS china_inventory (
  id TEXT PRIMARY KEY,
  number INTEGER,
  status TEXT DEFAULT 'open',      -- open / done / cancelled
  cell_filter TEXT,                -- если считали только одну ячейку
  started_at TEXT,
  finished_at TEXT,
  user TEXT,
  comment TEXT
);

CREATE TABLE IF NOT EXISTS china_inventory_items (
  id TEXT PRIMARY KEY,
  inventory_id TEXT,
  stock_id TEXT,
  barcode TEXT,
  article TEXT,
  name TEXT,
  cell TEXT,
  expected_qty REAL DEFAULT 0,     -- сколько числилось на момент старта
  counted_qty REAL,                -- сколько насчитали руками (null = ещё не считали)
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS china_purchase_history (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT,
  from_status TEXT,
  to_status TEXT,
  user TEXT,
  comment TEXT,
  created_at TEXT
);

-- ---------- Зарплата: начисления, вычеты, выплаты ----------
-- Расценка НЕ дублируется: она берётся из price_items.labor_rate в момент
-- начисления и фиксируется в строке — чтобы потом изменение расценки в
-- Справочнике не переписало задним числом уже принятые работы.
CREATE TABLE IF NOT EXISTS payroll_entries (
  id TEXT PRIMARY KEY,
  employee_id TEXT,
  production_id TEXT,              -- если работа выросла из заказа
  order_id TEXT,
  warehouse_stock_id TEXT,         -- если делали на запас, на склад
  shop TEXT,                       -- SA / PFS / УД — откуда пришла работа
  article TEXT,
  product_name TEXT,
  qty REAL DEFAULT 1,
  rate REAL DEFAULT 0,             -- расценка за штуку на момент начисления
  amount REAL DEFAULT 0,           -- rate * qty, считает сервер
  kind TEXT DEFAULT 'order',       -- order | stock
  status TEXT DEFAULT 'pending',   -- pending (ещё не принято) | payable (к выплате) | paid | cancelled
  comment TEXT,
  accepted_at TEXT,
  accepted_by TEXT,
  paid_at TEXT,
  payout_id TEXT,
  created_by TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  number INTEGER,
  employee_id TEXT,
  accrued REAL DEFAULT 0,          -- сумма принятых работ, вошедших в выплату
  deductions_total REAL DEFAULT 0,
  amount REAL DEFAULT 0,           -- к выдаче на руки
  comment TEXT,
  created_by TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS payout_deductions (
  id TEXT PRIMARY KEY,
  payout_id TEXT,
  kind TEXT,                       -- аванс / брак / материал / прочее
  amount REAL DEFAULT 0,
  comment TEXT
);

-- Доска задач: простые поручения сотрудникам — купить, сделать, съездить.
-- Намеренно отдельно от «Производства»: там работа по заказам и деньги,
-- здесь — бытовые дела, за которые зарплата не начисляется.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT DEFAULT 'other',       -- buy (купить) | make (сделать) | other
  status TEXT DEFAULT 'todo',      -- todo | doing | done
  priority TEXT DEFAULT 'normal',  -- low | normal | high
  employee_id TEXT,                -- кому поручено
  due_date TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  done_at TEXT,
  done_by TEXT,
  is_archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_source ON orders(source);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_status_history_order ON status_history(order_id);
CREATE INDEX IF NOT EXISTS idx_cargo_places_order ON cargo_places(order_id);
CREATE INDEX IF NOT EXISTS idx_print_log_order ON print_log(order_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_order ON audit_log(order_id);
CREATE INDEX IF NOT EXISTS idx_price_list_items_list ON price_list_items(price_list_id);
CREATE INDEX IF NOT EXISTS idx_price_lists_owner ON price_lists(owner, kind);
CREATE INDEX IF NOT EXISTS idx_china_po_status ON china_purchase_orders(status, is_archived);
CREATE INDEX IF NOT EXISTS idx_china_po_supplier ON china_purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_china_po_dates ON china_purchase_orders(order_date, plan_arrive_date);
CREATE INDEX IF NOT EXISTS idx_china_po_items_order ON china_purchase_order_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_china_history_order ON china_purchase_history(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_china_stock_cell ON china_stock(cell);
CREATE INDEX IF NOT EXISTS idx_china_stock_barcode ON china_stock(barcode);
CREATE INDEX IF NOT EXISTS idx_china_stock_order ON china_stock(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_china_stock_moves_stock ON china_stock_moves(stock_id);
CREATE INDEX IF NOT EXISTS idx_china_inv_items ON china_inventory_items(inventory_id);
CREATE INDEX IF NOT EXISTS idx_payroll_employee ON payroll_entries(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_production ON payroll_entries(production_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payout ON payroll_entries(payout_id);
CREATE INDEX IF NOT EXISTS idx_payouts_employee ON payouts(employee_id);
CREATE INDEX IF NOT EXISTS idx_payout_deductions ON payout_deductions(payout_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, is_archived);
CREATE INDEX IF NOT EXISTS idx_tasks_employee ON tasks(employee_id);
`;

export function ensureSchema() {
  db.exec(SCHEMA);

  // Безопасно добавляем колонки, которых не было в самых первых версиях схемы
  // (SQLite не поддерживает "ADD COLUMN IF NOT EXISTS", поэтому просто игнорируем
  // ошибку "duplicate column", если колонка уже есть)
  const safeAddColumn = (table, def) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`); } catch (e) { /* уже есть — ок */ }
  };
  safeAddColumn("orders", "order_date TEXT");
  safeAddColumn("orders", "arrived_date TEXT");
  safeAddColumn("orders", "product_photo TEXT");
  safeAddColumn("orders", "buy_price_cny REAL");
  safeAddColumn("orders", "buy_price_kzt REAL");
  safeAddColumn("orders", "delivery_price REAL");
  safeAddColumn("orders", "entries_raw TEXT");
  safeAddColumn("orders", "sale_price REAL");
  safeAddColumn("orders", "category TEXT");
  safeAddColumn("orders", "actual_qty REAL");
  safeAddColumn("orders", "kaspi_creation_date TEXT"); // настоящая дата создания заказа В KASPI (не в нашей базе!)
  safeAddColumn("orders", "manual_packing INTEGER DEFAULT 0"); // пользователь вручную перенёс предзаказ в нашу "Упаковку" — не зависит от того, что говорит Kaspi
  safeAddColumn("orders", "courier_transmission_planning_date TEXT"); // срок упаковки от Kaspi — по нему кабинет переводит заказ в "Упаковка"

  // ── Единоразовая доначистка: для заказов, у которых kaspi_creation_date ещё
  // пуст, достаём creationDate из уже сохранённого raw (сырой JSON от Kaspi) —
  // это чинит СУЩЕСТВУЮЩИЕ старые заказы сразу, не дожидаясь их пересинхронизации
  // (которая для по-настоящему зависших заказов и так не происходит — в этом и
  // была вся проблема).
  {
    const needsBackfill = db.prepare(
      "SELECT id, raw FROM orders WHERE source = 'kaspi' AND kaspi_creation_date IS NULL AND raw IS NOT NULL"
    ).all();
    for (const row of needsBackfill) {
      try {
        const raw = JSON.parse(row.raw || "{}");
        if (raw.creationDate) {
          const iso = new Date(raw.creationDate).toISOString();
          db.prepare("UPDATE orders SET kaspi_creation_date = ? WHERE id = ?").run(iso, row.id);
        }
      } catch (e) { /* битый raw — пропускаем, забэкфилится при следующей синхронизации */ }
    }
    if (needsBackfill.length) {
      console.log(`[db] Доначистка kaspi_creation_date: обработано ${needsBackfill.length} заказов`);
    }
  }

  // ── Справочник товаров: поля, подтягиваемые из выгрузки Kaspi "Активные товары" ──
  // article (уже существующее поле) используется как SKU для сопоставления.
  // name/type/cost/retail — остаются ручными полями (название для печати,
  // категория, себестоимость, наша розница) и НИКОГДА не перезаписываются импортом.
  safeAddColumn("price_items", "kaspi_name TEXT");              // сырое название с Kaspi (авто)
  safeAddColumn("price_items", "kaspi_price REAL");             // цена на Kaspi (авто)
  safeAddColumn("price_items", "kaspi_in_stock_points INTEGER"); // сколько ПВЗ из общего числа — есть в наличии
  safeAddColumn("price_items", "kaspi_total_points INTEGER");    // всего ПВЗ в выгрузке
  safeAddColumn("price_items", "kaspi_preorder_days INTEGER");   // дни допоставки
  safeAddColumn("price_items", "kaspi_synced_at TEXT");          // когда последний раз обновлено импортом
  safeAddColumn("price_items", "subgroup TEXT");                 // "Подраздел" — второй уровень группировки внутри категории (type), для печатного прайса

  // ── Поля по образцу справочника PRODIX (расценка труда нужна для "Зарплаты") ──
  // Права и привязка пользователя к сотруднику (для зарплаты забивщика)
  safeAddColumn("users", "permissions TEXT");            // JSON-список разрешённых разделов
  safeAddColumn("users", "employee_id TEXT");            // кто это из сотрудников — чтобы работа падала ему
  safeAddColumn("users", "is_active INTEGER DEFAULT 1"); // уволился — отключаем, история остаётся
  // Первый вход по временному паролю обязывает сменить его: так пароли
  // сотрудников не знает даже администратор
  safeAddColumn("users", "must_change_password INTEGER DEFAULT 0");
  safeAddColumn("users", "last_login_at TEXT");
  safeAddColumn("users", "last_login_ip TEXT");
  // Забивщик отмечает «готово», менеджер подтверждает — только тогда к выплате
  // Метка переноса из старой системы: чтобы повторный импорт не задвоил деньги
  safeAddColumn("payroll_entries", "legacy_key TEXT");
  safeAddColumn("payroll_entries", "reported_done INTEGER DEFAULT 0");
  safeAddColumn("payroll_entries", "reported_at TEXT");
  safeAddColumn("payroll_entries", "reported_by TEXT");

  // Позицию можно убрать в архив: не удаляем (на неё ссылаются заказы и
  // начисления), но из списков и прайса она уходит
  safeAddColumn("price_items", "is_archived INTEGER DEFAULT 0");

  safeAddColumn("price_items", "labor_rate REAL");     // РАСЦЕНКА ТРУДА — ставка за 1 шт, читает раздел "Зарплата"
  safeAddColumn("price_items", "material_cost REAL");  // Затраты на материал
  safeAddColumn("price_items", "misc_cost REAL");      // Прочие затраты
  safeAddColumn("price_items", "rags_cost REAL");      // Ветошь (расходники на производстве)

  // ── Поля специально для нового конструктора "Прайс" (компании + PDF) ──
  safeAddColumn("price_items", "show_in_price INTEGER DEFAULT 1"); // "Показывать в прайсе" — по умолчанию да, чтобы старые товары не пропали молча
  safeAddColumn("price_items", "sort_order INTEGER DEFAULT 0");    // порядок внутри группы (Ø/материал)
  safeAddColumn("price_items", "price_display_name TEXT");         // отдельное название для печати, если отличается от обычного name

  // ── Разовая доначистка: старые ручные заказы (созданные до фикса), у которых
  // в поле "магазин" оказался произвольный текст из формы — приводим к
  // единому "УД", как и должно быть у всех заказов, созданных вручную.
  db.prepare("UPDATE orders SET shop = 'УД' WHERE source = 'manual' AND kaspi_code LIKE 'УД-%' AND shop != 'УД'").run();

  // ── Полная цепочка стадий заказа в производстве (доработка по ТЗ) ──
  // pending -> in_production/from_stock -> ready -> packed -> issued
  // плюс отдельные ветки: cancelled, returned_to_stock, archived
  safeAddColumn("production", "stage TEXT DEFAULT 'pending'");
  safeAddColumn("production", "cancellation_reason TEXT"); // при отмене: одна из 5 причин (см. resolveCancellation)
  safeAddColumn("production", "archived_at TEXT");
  safeAddColumn("production", "quantity INTEGER DEFAULT 1");
  safeAddColumn("production", "shop TEXT");
  // Менеджер решает, что уходит забивщикам: пока заказ не «опубликован»,
  // в мониторе его не видно — иначе там висело бы всё подряд
  safeAddColumn("production", "published INTEGER DEFAULT 0");
  safeAddColumn("production", "published_at TEXT");
  safeAddColumn("production", "published_by TEXT");

  // ── Богаче поля для "Остатков" ──
  safeAddColumn("warehouse_stock", "location TEXT");   // место хранения (свободный текст)
  safeAddColumn("warehouse_stock", "status TEXT DEFAULT 'available'"); // available | reserved | damaged
  safeAddColumn("warehouse_stock", "comment TEXT");

  const kaspiShopsRow = db.prepare("SELECT value FROM settings WHERE key = 'kaspi_shops'").get();
  if (!kaspiShopsRow) {
    const defaultShops = [
      { name: "Магазин 1", token: "" },
      { name: "Магазин 2", token: "" },
      { name: "Магазин 3", token: "" }
    ];
    db.prepare("INSERT INTO settings (key, value) VALUES ('kaspi_shops', ?)").run(JSON.stringify(defaultShops));
  }

  const ensureMeta = (key, def) => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    if (!row) db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(key, String(def));
  };
  ensureMeta("next_receipt_number", 1);
  ensureMeta("next_kaspi_number", 1); // старый общий счётчик — оставлен только для миграции ниже, дальше не используется
  ensureMeta("version", "1.0.0");

  // ── Переход на раздельную нумерацию по магазинам ──
  // Раньше был один общий счётчик на все магазины сразу (номера SA и PFS шли
  // вперемешку). Теперь у каждого магазина свой счётчик. Чтобы новые номера не
  // столкнулись с уже использованными старыми, для каждого настроенного
  // магазина создаём отдельный счётчик, инициализируя его текущим значением
  // старого общего — дальше можно развести по-своему через настройки.
  {
    const oldShared = db.prepare("SELECT value FROM meta WHERE key = 'next_kaspi_number'").get();
    const startFrom = oldShared ? oldShared.value : "1";
    const shopsRow2 = db.prepare("SELECT value FROM settings WHERE key = 'kaspi_shops'").get();
    const shopsList = shopsRow2 ? JSON.parse(shopsRow2.value) : [];
    for (const s of shopsList) {
      if (!s.name) continue;
      const perShopKey = `next_kaspi_number:${s.name}`;
      const existing = db.prepare("SELECT value FROM meta WHERE key = ?").get(perShopKey);
      if (!existing) db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(perShopKey, startFrom);
    }
  }
}

export function ensureBootstrapUser() {
  const userCount = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  if (userCount === 0) {
    const bootstrapUser = process.env.ADMIN_USER || "admin";
    const bootstrapPass = process.env.ADMIN_PASS || "admin";
    db.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
      .run("u_admin", bootstrapUser, bcrypt.hashSync(bootstrapPass, 10), new Date().toISOString());
    console.log(`[init] Создан пользователь по умолчанию: ${bootstrapUser} / ${bootstrapPass} (смените пароль после первого входа)`);
  }
}

export function initDb() {
  ensureSchema();
  ensureBootstrapUser();
}

export function getMeta(key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}
export function setMeta(key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}
export function nextReceiptNumber() {
  const n = parseInt(getMeta("next_receipt_number") || "1", 10);
  setMeta("next_receipt_number", n + 1);
  return n;
}
export function nextKaspiNumber(shopName) {
  // Свой счётчик на каждый магазин (SA/PFS не путаются). Без имени магазина —
  // старый общий счётчик, оставлен только для обратной совместимости на случай
  // вызова откуда-то ещё без параметра.
  const key = shopName ? `next_kaspi_number:${shopName}` : "next_kaspi_number";
  const n = parseInt(getMeta(key) || "1", 10);
  setMeta(key, n + 1);
  return n;
}

export function getKaspiShops() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'kaspi_shops'").get();
  let shops = row ? JSON.parse(row.value) : [];
  // Защита: массив всегда должен быть ровно из 3 элементов — если после
  // старых миграций/данных он короче или длиннее, выравниваем
  while (shops.length < 3) shops.push({ name: `Магазин ${shops.length + 1}`, token: "" });
  if (shops.length > 3) shops = shops.slice(0, 3);
  return shops;
}
export function setKaspiShops(shops) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('kaspi_shops', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(shops));
}

export function logAudit({ user, action, orderId = null, oldValue = null, newValue = null, comment = null, ip = null }) {
  db.prepare(`INSERT INTO audit_log (user, action, order_id, old_value, new_value, comment, ip, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      user || "unknown", action, orderId,
      oldValue != null ? String(oldValue) : null,
      newValue != null ? String(newValue) : null,
      comment, ip, new Date().toISOString()
    );
}
