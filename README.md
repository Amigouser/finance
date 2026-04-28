# Финансы — личная финансовая хроника

Самостоятельное веб-приложение для учёта личных финансов. Frontend (один HTML-файл, editorial-стиль) + Node.js backend + SQLite в одном файле. Пишется на свой сервер, своим доменом — ничего наружу.

## Возможности

- Учёт расходов и доходов по дням, с категориями
- Сводка месяца: баланс, доходы, расходы, среднее в день
- Спарклайн баланса нарастающим итогом за текущий месяц
- Инсайты месяца: динамика расходов, главный рост, самый дорогой день недели, прогноз на конец месяца, крупнейший расход
- Тренд по месяцам — столбиковая диаграмма за последние 6 месяцев (доходы/расходы)
- **Импорт JSON** — для рабочего процесса «фото чека → нейросеть → JSON → вставить в сайт», с автопочинкой кривого JSON (умные кавычки, лишние запятые, экранирование)
- Структура расходов по категориям с прогресс-барами
- Хроника операций: поиск, фильтр по периоду (месяц/год/всё), фильтр по категориям
- Редактирование записи кликом по строке
- Экспорт всего архива в CSV или JSON
- Светлая и тёмная темы
- PWA: можно «установить» как приложение, работает в офлайне (статика)
- Адаптивно под мобильные
- Авторизация по токену в `Authorization: Bearer`

## Локально (на разработческой машине)

```bash
npm install
# создайте .env с переменной ACCESS_TOKEN
echo 'ACCESS_TOKEN=ваш_длинный_секрет' > .env
npm start
```

Требуется Node.js **22.5+** (используется встроенный модуль `node:sqlite`, без `better-sqlite3` и нативной сборки).

Откройте `http://localhost:3000`. При первом входе попросит токен — введите тот же, что в `.env`.

## Деплой в Proxmox LXC

### 1. Создайте контейнер

В Proxmox: `Create CT` → шаблон Debian 12 (или Ubuntu 22.04), 1 ядро, 512 МБ RAM, 4 ГБ диска — этого с запасом. Unprivileged. Сеть с DHCP или статическим IP.

### 2. Поставьте Node.js 22+

```bash
apt update && apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

> Нужен Node 22.5 или новее — для встроенного `node:sqlite`. Никакого `build-essential` не требуется, нативной сборки нет.

### 3. Скопируйте приложение

```bash
mkdir -p /opt/kapital && cd /opt/kapital
# залейте сюда index.html, server.js, package.json, sw.js, manifest.json, icon.svg
# через scp / rsync / git clone — как удобнее

useradd -r -s /usr/sbin/nologin kapital
mkdir -p data && chown -R kapital:kapital /opt/kapital
```

### 4. Настройте окружение

```bash
# Сгенерируйте сильный токен:
openssl rand -hex 32
# Создайте .env:
echo 'ACCESS_TOKEN=сюда_ваш_токен' > .env

npm install --omit=dev
```

### 5. systemd

```bash
cp kapital.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kapital
systemctl status kapital
journalctl -u kapital -f   # логи в реальном времени
```

### 6. Домен и HTTPS

Поставьте на хост (или в отдельный LXC) **Caddy** — он сам получит сертификат Let's Encrypt:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Скопируйте `Caddyfile.example` в `/etc/caddy/Caddyfile`, поменяйте домен и IP контейнера, затем:

```bash
systemctl reload caddy
```

Проверьте, что A-запись домена ведёт на ваш белый IP, а на роутере проброшены порты 80/443 на хост Caddy.

### 7. Резервная копия

Вся БД — это один файл `/opt/kapital/data/finance.db`. Бэкап:

```bash
sqlite3 /opt/kapital/data/finance.db ".backup '/path/to/backup.db'"
```

Можно завести cron: ежедневно копировать в Proxmox-стораж или на NAS. Дополнительно — кнопка «Скачать JSON» в разделе «Хроника» сохраняет весь архив транзакций в один файл.

## Импорт JSON из нейросети

В разделе «Импорт» есть кнопка **«Скопировать промпт для нейросети»** — она кладёт в буфер обмена готовый текст. Прикрепите фото чека к LLM (Claude, ChatGPT, Gemini), вставьте этот промпт — нейросеть вернёт массив JSON. Скопируйте его обратно в поле импорта на сайте, нажмите «Импортировать». Можно также загрузить `.json`-файл кнопкой рядом.

Если LLM вернёт JSON с типичными косяками (умные кавычки `“ ”`, висящие запятые, лишние блоки ```` ```json ````), сайт попытается починить его автоматически и сообщит об этом в строке статуса.

Формат, который ожидает сайт:

```json
[
  { "name": "Хлеб бородинский", "amount": 75,   "category": "Еда",        "date": "2026-04-27", "type": "expense" },
  { "name": "Молоко 3,2%",      "amount": 95,   "category": "Еда",        "date": "2026-04-27", "type": "expense" },
  { "name": "Аренда квартиры",   "amount": 65000, "category": "Жильё",     "date": "2026-04-15", "type": "expense" }
]
```

Поля `category`, `date`, `type` — необязательные. Если не указаны: `category="Другое"`, `date=сегодня`, `type="expense"`. Допустимые форматы даты: `2026-04-27`, `27.04.2026`, `27/04/2026`. Сумма принимается как число, со знаком пробела или с запятой как разделителем.

## API

Все запросы требуют `Authorization: Bearer <ACCESS_TOKEN>`.

| Метод  | Путь                          | Описание                                           |
|--------|-------------------------------|----------------------------------------------------|
| GET    | `/api/health`                 | health-check (без авторизации)                     |
| POST   | `/api/auth/check`             | проверить токен                                    |
| GET    | `/api/categories`             | список канонических категорий                      |
| GET    | `/api/transactions`           | все транзакции                                     |
| POST   | `/api/transactions`           | добавить одну                                      |
| POST   | `/api/transactions/bulk`      | добавить много (массив или `{items: []}`)          |
| PUT    | `/api/transactions/:id`       | обновить запись                                    |
| DELETE | `/api/transactions/:id`       | удалить                                            |
| GET    | `/api/settings`               | получить настройки (произвольные ключ→значение)    |
| PUT    | `/api/settings`               | обновить настройки                                 |

## Структура проекта

```
.
├── index.html           — фронт (один файл, editorial-стиль)
├── server.js            — Node.js + Express + node:sqlite
├── package.json
├── manifest.json        — PWA manifest
├── sw.js                — service worker (офлайн-кэш статики)
├── icon.svg             — иконка приложения
├── kapital.service      — unit для systemd
├── Caddyfile.example    — пример reverse proxy
└── data/finance.db      — БД (создаётся при запуске)
```

## Переменные окружения

| Имя             | По умолчанию                  | Описание                                          |
|-----------------|-------------------------------|---------------------------------------------------|
| `ACCESS_TOKEN`  | — (обязательно, ≥ 8 символов) | Bearer-токен для всех `/api/*`                    |
| `PORT`          | `3000`                        | порт                                              |
| `HOST`          | `0.0.0.0`                     | интерфейс                                         |
| `DB_PATH`       | `./data/finance.db`           | путь к файлу БД                                   |
