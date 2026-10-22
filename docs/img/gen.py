# Генератор схем документации шлюза. Запуск: python3 docs/img/gen.py (пишет рядом с собой) → message-path.svg,
# responsibilities.svg, workflows-map.svg
# Ширина текста меряется по Arial (PIL) с запасом 10 %: перенос строк считает код, а не глаз.
from pathlib import Path
from PIL import ImageFont
from xml.sax.saxutils import escape

FONT = "Mulish, 'Golos Text', system-ui, -apple-system, 'Segoe UI', sans-serif"
INK, MUTED, SOFT = "#1C1C1A", "#6A6A66", "#3A3A38"
BG, CARD, LINE = "#F3F7F7", "#FFFFFF", "#E3EAEA"
TEAL, TEAL_L = "#00695E", "#C7E2D8"
ORANGE, ORANGE_L = "#F28D20", "#FAE5C4"
GREY, GREY_L = "#6A6A66", "#E3EAEA"
RED = "#1C1C1A"  # красного в палитре нет: сбой — тёмно-серый
# цвета по смыслу: оранжевый — человек (владелец, его решения), зелёный — агенты и машина

_fonts = {}
def _font(size, bold):
    key = (round(size * 2), bold)
    if key not in _fonts:
        path = "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf"
        _fonts[key] = ImageFont.truetype(path, int(size * 4))
    return _fonts[key]

def width(s, size, bold=False):
    return _font(size, bold).getlength(s) / 4 * 1.10

def wrap(s, w, size, bold=False):
    out = []
    for para in s.split("\n"):
        line = ""
        for word in para.split(" "):
            cand = (line + " " + word).strip()
            if width(cand, size, bold) <= w or not line:
                line = cand
            else:
                out.append(line)
                line = word
        out.append(line)
    return out

class Svg:
    def __init__(self, w, h, title, desc):
        self.w, self.h, self.parts = w, h, []
        self.head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
                     f'font-family="{FONT}" role="img" aria-labelledby="t1 d1">\n'
                     f'<title id="t1">{escape(title)}</title>\n<desc id="d1">{escape(desc)}</desc>\n'
                     '<defs>'
                     f'<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{SOFT}"/></marker>'
                     f'<marker id="at" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{TEAL}"/></marker>'
                     '</defs>\n'
                     f'<rect width="{w}" height="{h}" fill="{BG}"/>\n')

    def add(self, s):
        self.parts.append(s)

    def rect(self, x, y, w, h, fill=CARD, stroke=LINE, rx=8, sw=1, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def text(self, x, y, s, size=12, color=INK, bold=False, anchor="start", italic=False):
        wgt = "700" if bold else "400"
        st = ' font-style="italic"' if italic else ""
        self.add(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{wgt}" text-anchor="{anchor}"{st}>{escape(s)}</text>')

    def para(self, x, y, s, w, size=12, color=INK, bold=False, lh=None, anchor="start"):
        lh = lh or round(size * 1.38, 1)
        lines = wrap(s, w, size, bold)
        for i, ln in enumerate(lines):
            self.text(x, y + i * lh, ln, size, color, bold, anchor)
        return len(lines) * lh

    def arrow(self, x1, y1, x2, y2, color=SOFT, dash=None, marker="a", sw=1.6):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{sw}"{d} marker-end="url(#{marker})"/>')

    def header(self, title, sub):
        self.text(24, 40, title, 22, INK, True)
        self.text(24, 64, sub, 13, MUTED)

    def save(self, path):
        with open(Path(__file__).parent / path, "w", encoding="utf-8") as f:
            f.write(self.head + "\n".join(self.parts) + "\n</svg>\n")


# ── 1. Путь сообщения ─────────────────────────────────────────────────────────
def message_path():
    s = Svg(1200, 700, "Как идёт сообщение через шлюз",
            "Telegram → шлюз (кто пишет, запись в базу, «получил», квитанция, команды, голос, эпизод; база и файлы — внутри шлюза) → "
            "по локальному сокету шлюза → переходник (адаптер) агентной среды → ответ обратно через шлюз.")
    s.header("Как идёт сообщение", "Telegram ⇄ шлюз (база внутри) ⇄ сокет шлюза ⇄ переходник ⇄ агент · переходники меняются, шлюз тот же")

    # Telegram
    s.rect(24, 96, 150, 480, CARD, LINE)
    s.text(40, 124, "Telegram", 16, INK, True)
    s.rect(34, 138, 130, 72, ORANGE_L, ORANGE, 6)
    s.para(44, 159, "Владелец пишет текстом, голосом, пересылает", 112, 11.5, INK)
    s.rect(34, 330, 130, 52, CARD, TEAL, 6)
    s.para(44, 351, "👀  № 118 (эп. 42) записал: «…»", 112, 11.5, INK)
    s.rect(34, 492, 130, 66, TEAL_L, TEAL, 6)
    s.para(44, 512, "ответ агента — текстом или голосом", 112, 11.5, INK)

    # Шлюз — процесс; база и файлы внутри
    gx, gw = 236, 712
    s.rect(gx, 96, gw, 480, CARD, TEAL, 10, 1.6)
    s.text(gx + 16, 124, "Шлюз", 16, INK, True)
    s.text(gx + 70, 124, "отдельный процесс · ключи и база только здесь · сейчас без модели", 12, MUTED)
    steps = [
        ("Кто пишет?", "по правилам доступа; незнакомым — молчание"),
        ("👀 — сразу", "реакция ещё до записи"),
        ("Записать в базу", "событие и смещение — одной транзакцией"),
        ("Только теперь Telegram: «получил»", "упал раньше — Telegram пришлёт то же снова"),
        ("Квитанция и команды — кодом", "«№ N записал»; стоп, «где мы» — мимо агента"),
        ("Голос и эпизод", "распознаёт после записи; «Тема · Роль»"),
        ("Отдать переходнику · отправить ответ", "по сокету; ответ — текстом или голосом"),
    ]
    sw_steps = 420
    y0, step_h, gap = 140, 54, 7
    centers = []
    for i, (t, d) in enumerate(steps):
        y = y0 + i * (step_h + gap)
        s.rect(gx + 12, y, sw_steps, step_h, BG, LINE, 6)
        s.add(f'<circle cx="{gx + 32}" cy="{y + 27}" r="11" fill="{TEAL}"/>')
        s.text(gx + 32, y + 31.5, str(i + 1), 12, "#FFFFFF", True, "middle")
        s.text(gx + 52, y + 22, t, 13.5, INK, True)
        s.text(gx + 52, y + 41, d, 12, SOFT)
        centers.append(y + step_h / 2)

    # Хранилище — внутри шлюза
    qx, qw = gx + sw_steps + 40, 236
    s.rect(qx, 150, qw, 396, BG, SOFT, 10, 1.2)
    s.add(f'<ellipse cx="{qx + qw / 2}" cy="150" rx="{qw / 2}" ry="10" fill="{GREY_L}" stroke="{SOFT}" stroke-width="1.2"/>')
    s.text(qx + qw / 2, 184, "База SQLite", 14.5, INK, True, "middle")
    s.text(qx + qw / 2, 202, "пишет только шлюз", 11.5, MUTED, False, "middle")
    for i, item in enumerate(["входящие и смещение", "исходящие", "эпизоды", "кнопки · журнал правил"]):
        yy = 218 + i * 36
        s.rect(qx + 12, yy, qw - 24, 28, CARD, LINE, 5)
        s.text(qx + qw / 2, yy + 18.5, item, 11.5, INK, False, "middle")
    s.text(qx + qw / 2, 382, "рядом — файлы", 11.5, MUTED, False, "middle")
    s.rect(qx + 12, 392, qw - 24, 28, CARD, LINE, 5)
    s.text(qx + qw / 2, 410.5, "звук · правила · журнал", 11.5, INK, False, "middle")
    s.rect(qx + 12, 440, qw - 24, 90, TEAL_L, TEAL, 6)
    s.para(qx + qw / 2, 466, "Записано здесь — значит, не потеряется", qw - 44, 12.5, INK, True, anchor="middle")
    s.arrow(gx + 12 + sw_steps, centers[2], qx, centers[2]); s.text(gx + sw_steps + 32, centers[2] - 7, "запись", 10, MUTED, False, "middle")

    # Сокет шлюза — граница
    sx = gx + gw
    s.rect(sx - 6, 150, 12, 396, TEAL, TEAL, 3)
    s.text(sx + 26, 142, "сокет", 10.5, INK, True, "middle")

    # Переходники
    ax, aw = 1024, 152
    def adapter(y, h, l1, l2, pill, pill_w, text, live):
        if live:
            s.rect(ax, y, aw, h, CARD, TEAL, 10, 1.6)
            s.rect(ax + 14, y + 56, pill_w, 22, TEAL_L, TEAL, 11)
        else:
            s.rect(ax, y, aw, h, CARD, GREY, 10, 1.4, "6 4")
            s.rect(ax + 14, y + 56, pill_w, 22, GREY_L, GREY, 11)
        s.text(ax + 14, y + 26, l1, 14, INK, True)
        s.text(ax + 14, y + 44, l2, 14, INK, True)
        s.text(ax + 14 + pill_w / 2, y + 71, pill, 10.5, INK, False, "middle")
        s.para(ax + 14, y + 98, text, aw - 28, 11.5, SOFT)
    adapter(150, 188, "Переходник", "к Claude Code", "macOS · сейчас", 96, "MCP-сервер: Claude Code запускает его с сессией агента; агент видит его инструменты.", True)
    adapter(352, 92, "Переходник", "к серверу", "позже", 52, "", False)
    adapter(458, 92, "Переходник", "к платформам", "позже", 52, "", False)

    # стрелки
    s.arrow(174, centers[0], gx + 12, centers[0]); s.text(212, centers[0] - 7, "сообщение", 10, MUTED, False, "middle")
    s.arrow(gx + 12, 356, 164, 356, TEAL, marker="at"); s.text(212, 349, "квитанция", 10, MUTED, False, "middle")
    s.arrow(gx + 12, centers[6], 164, centers[6], TEAL, marker="at"); s.text(212, centers[6] - 7, "ответ", 10, MUTED, False, "middle")
    s.arrow(sx + 6, 214, ax, 214); s.text(988, 207, "событие", 10, MUTED, False, "middle")
    s.arrow(ax, 262, sx + 6, 262, TEAL, marker="at"); s.text(988, 255, "ответ,", 10, MUTED, False, "middle"); s.text(988, 280, "обработано", 10, MUTED, False, "middle")
    for yy in (398, 504):
        s.arrow(sx + 6, yy, ax, yy, GREY, "5 4")

    # низ
    notes = [
        (RED, "Агент упал или Claude Code закрыт", "событие ждёт в базе без отметки и отдаётся снова; владельцу — строка «сообщения сохраняю»"),
        (TEAL, "Ключи и база — только у шлюза", "переходник говорит со шлюзом по сокету; агенту ключи не нужны, в базу он не пишет"),
        (GREY, "Переходники меняются, шлюз тот же", "сейчас Claude Code на macOS, позже сервер и другие агентские платформы — один протокол сокета"),
    ]
    for i, (c, t, d) in enumerate(notes):
        x = 24 + i * 388
        s.rect(x, 596, 376, 84, CARD, LINE)
        s.add(f'<rect x="{x}" y="596" width="5" height="84" rx="2" fill="{c}"/>')
        s.text(x + 18, 620, t, 13.5, INK, True)
        s.para(x + 18, 640, d, 344, 12, SOFT)
    s.save("message-path.svg")


# ── 2. Кто за что отвечает ────────────────────────────────────────────────────
def responsibilities():
    rows = [
        ("Кто пишет и где", "сверяет номер с правилами доступа, ставит метку; незнакомым — молчание", "видит метку; ставит её шлюз", None, False),
        ("Правила доступа", "хранит файлом и исполняет, не толкуя", "меняет инструментом: сузить — сразу; расширить — только с касанием владельца", "правило", True),
        ("Внешняя роль", "по правилам: чат × человек → внешняя роль; на сервере внутреннюю применяет код", "предлагает сменить; роль с доступом шире — с касанием владельца", "роль", True),
        ("Эпизод", "номер, журнал, тишина 33 минуты, тема Telegram, «новая тема», строка «Тема · Роль»", "замечает смену темы по смыслу и объявляет; пишет итог", "эпизод · итог", False),
        ("Сохранность", "запись до «получил», очередь, повтор отданного", "отвечает — это и есть «обработано»", "ответить", False),
        ("Команды", "стоп, пауза, продолжить, «где мы» — сам, мимо очереди; снять стоп — кнопкой", "не участвует", None, False),
        ("Голос и ключи", "распознаёт и озвучивает; ключи и токен бота только здесь", "решает: голосом или текстом", "ответить", False),
        ("Права агента", "сервер: отдельный пользователь ОС без сети и ключей, три инструмента; macOS: пока без песочниц", "работает внутри своих прав; уговорённый — не дальше их", None, False),
        ("Смысл", "сейчас не толкует; позже — свои фильтры и модели под задачу", "понимает, раскладывает, отвечает; управляет фильтрами шлюза", None, False),
    ]
    W = 1200
    lx, lw = 24, 150
    gx, gw = 186, 400
    tx, tw = 598, 124
    agx, agw = 734, 442
    heights = []
    for label, g, a, tool, touch in rows:
        hg = len(wrap(g, gw - 32, 12.5)) * 17.5
        ha = len(wrap(a, agw - 32, 12.5)) * 17.5 + (26 if touch else 0)
        heights.append(max(hg, ha, 18) + 26)
    H = 176 + sum(heights) + 8 * len(rows) + 104
    s = Svg(W, int(H), "Кто за что отвечает: шлюз и агент",
            "Что проверяется кодом — делает шлюз; что требует понимания смысла — агент; решение агента становится действием "
            "только через инструмент, который проверяет шлюз (на сервере — устройством, на macOS — правами сессии); "
            "расширение доступа и роли шире — с касанием владельца.")
    s.header("Кто за что отвечает: шлюз и агент", "что проверяется кодом — шлюз · что требует смысла — агент · между ними — инструменты, их проверяет шлюз")
    # шапки колонок
    s.rect(gx, 92, gw, 64, BG, INK, 8, 1.4)
    s.text(gx + 16, 118, "Шлюз", 16, INK, True)
    s.text(gx + 16, 140, "код · исполняет правила · позже свои модели", 12, SOFT)
    s.rect(tx, 92, tw, 64, GREY_L, GREY, 8, 1.2)
    s.text(tx + tw / 2, 118, "Инструменты", 13, INK, True, "middle")
    s.text(tx + tw / 2, 140, "путь к действию", 11, SOFT, False, "middle")
    s.rect(agx, 92, agw, 64, TEAL_L, TEAL, 8, 1.4)
    s.text(agx + 16, 118, "Агент", 16, INK, True)
    s.text(agx + 16, 140, "модель · понимает смысл · решает внутри правил", 12, SOFT)
    y = 168
    for (label, g, a, tool, touch), h in zip(rows, heights):
        s.text(lx, y + 22, label, 13.5, INK, True)
        s.rect(gx, y, gw, h, CARD, LINE, 6)
        s.add(f'<rect x="{gx}" y="{y}" width="4" height="{h}" rx="2" fill="{INK}"/>')
        s.para(gx + 16, y + 22, g, gw - 32, 12.5, SOFT, lh=17.5)
        s.rect(agx, y, agw, h, CARD, LINE, 6)
        s.add(f'<rect x="{agx}" y="{y}" width="4" height="{h}" rx="2" fill="{TEAL}"/>')
        ha = s.para(agx + 16, y + 22, a, agw - 32, 12.5, SOFT, lh=17.5)
        if touch:
            cy = y + 14 + ha
            s.rect(agx + 16, cy, 134, 22, ORANGE_L, ORANGE, 11)
            s.text(agx + 83, cy + 15, "касание владельца", 11, INK, True, "middle")
        if tool:
            my = y + h / 2
            s.rect(tx + 6, my - 13, tw - 12, 26, CARD, GREY, 13)
            s.text(tx + tw / 2, my + 4.5, tool, 11.5, INK, True, "middle")
            s.arrow(agx, my, tx + tw - 6, my, TEAL, marker="at")
            s.arrow(tx + 6, my, gx + gw, my, SOFT)
        y += h + 8
    # низ
    s.rect(24, y + 10, 1152, 80, CARD, LINE)
    s.add(f'<rect x="24" y="{y + 10}" width="5" height="80" rx="2" fill="{INK}"/>')
    s.text(42, y + 36, "Сейчас шлюз смысл не толкует, а агент действует через инструменты шлюза. Позже у шлюза — свои фильтры и модели, ими управляет агент.", 13.5, INK, True)
    s.para(42, y + 58, "Шлюз только сопоставляет чат с пространством и ролью и ведёт журнал эпизодов.", 1112, 12, SOFT)
    s.save("responsibilities.svg")


# ── 3. Карта циклов (WORKFLOWS.md) ────────────────────────────────────────────
# Список циклов берётся из таблицы «Какие циклы есть» в WORKFLOWS.md. Отдельного списка здесь нет, чтобы схема не
# разошлась с таблицей: цикл, которого нет в таблице, и цикл таблицы, которого нет на схеме, — ошибка сборки.


def _cycles_from_table():
    md = (Path(__file__).parent.parent / "WORKFLOWS.md").read_text(encoding="utf-8")
    sec = md.split("## Какие циклы есть", 1)[1].split("\n## ", 1)[0]
    ids = []
    for row in sec.splitlines():
        if not row.startswith("| `"):
            continue
        ids.append(row.split("`")[1])
    if not ids:
        raise SystemExit("WORKFLOWS.md: не нашёл таблицу «Какие циклы есть»")
    return ids


CYCLES = _cycles_from_table()


def known(cid):
    if cid not in CYCLES:
        raise SystemExit(f"цикла {cid} нет в таблице WORKFLOWS.md «Какие циклы есть»")
    return cid


def workflows_map():
    W, H = 1200, 1044
    s = Svg(W, H, "Циклы шлюза: что крутится внутри",
            "Модели в шлюзе нет. В центре — база SQLite: статусы строк и есть состояние. Вокруг — группы циклов; стрелка от "
            "группы к строке базы — циклы группы меняют эту таблицу, тикер меняет всю базу. Слева Telegram, справа канал "
            "stg-channel и сессия Claude Code. Внизу — внешний перезапуск процесса.")
    s.header("Циклы шлюза: что крутится внутри",
             "модели нет · состояние — статусы строк в базе · циклы их двигают · после падения продолжают с места")
    too_wide = []
    drawn = set()
    # Запас к ширине текста в блоках: меряем по Arial, а показывает Mulish или системный шрифт — они шире.
    PAD = 8

    def line(x, y, txt, w, size, color=INK, bold=False, anchor="start"):
        if width(txt, size, bold) > w:
            too_wide.append((txt, round(width(txt, size, bold)), w))
        s.text(x, y, txt, size, color, bold, anchor)

    def chips(x, y, w, ids, size=11):
        """Имена циклов; переносит по ширине w. Возвращает высоту."""
        cx, cy, lh, gap = x, y, size * 1.5, 11
        for cid in ids:
            drawn.add(known(cid))
            tw = width(cid, size)
            if cx > x and cx + tw > x + w:
                cx, cy = x, cy + lh
            s.text(cx, cy, cid, size, INK)
            cx += tw + gap
        return cy - y + lh

    def card(x, y, w, title, when, moves, ids, stroke=TEAL, stripe=TEAL, dash=None, fill=CARD):
        """Карточка группы циклов: заголовок · когда · что двигает · имена циклов. Возвращает (верх, низ)."""
        inner = w - 26
        lw_ = wrap(when, inner - PAD, 10.5)
        lm = wrap(moves, inner - PAD, 10.5)
        # высота: заголовок 22 · строки по 14 · имена циклов
        cx, rows = 0, 1
        for cid in ids:
            tw = width(cid, 11)
            if cx > 0 and cx + tw > inner - PAD:
                cx, rows = 0, rows + 1
            cx += tw + 11
        lt = wrap(title, inner, 13.5, True)
        h = 28 + (len(lt) - 1) * 17 + (len(lw_) + len(lm)) * 14 + 6 + rows * 16.5 + 4
        s.rect(x, y, w, h, fill, stroke, 8, 1.4, dash)
        s.add(f'<rect x="{x}" y="{y}" width="5" height="{h}" rx="2" fill="{stripe}"/>')
        for i, ln in enumerate(lt):
            line(x + 16, y + 21 + i * 17, ln, inner, 13.5, INK, True)
        yy = y + 38 + (len(lt) - 1) * 17
        for ln in lw_:
            s.text(x + 16, yy, ln, 10.5, MUTED); yy += 14
        for ln in lm:
            s.text(x + 16, yy, ln, 10.5, SOFT); yy += 14
        chips(x + 16, yy + 6, inner - PAD, ids)
        return y, y + h

    # ── рамки
    tx, tw_ = 24, 130                       # Telegram
    gx, gy, gr = 206, 92, 1004              # шлюз: слева, сверху, справа
    gb = 940                                # низ шлюза
    rx, rw = 1024, 152                      # снаружи справа: канал, Claude Code
    lx, lw = 222, 208                       # карточки слева
    dx, dw = 490, 240                       # база
    cx_, cw = 790, 198                      # карточки справа

    s.rect(tx, gy, tw_, gb - gy, CARD, LINE, 10)
    s.text(tx + 14, gy + 26, "Telegram", 16, INK, True)
    s.rect(gx, gy, gr - gx, gb - gy, CARD, TEAL, 10, 1.6)
    s.text(gx + 16, gy + 26, "Шлюз", 16, INK, True)
    line(gx + 66, gy + 26, "один процесс Node · модели нет · ключи и база только здесь", 420, 12, MUTED)
    s.rect(rx, gy, rw, gb - gy, CARD, LINE, 10)
    s.text(rx + 14, gy + 26, "Агент", 16, INK, True)

    # ── память процесса (над базой)
    my = gy + 44
    mem = wrap("аренда · «печатает…» · «диск полон» · сроки повтора · синтез — после перезапуска заново",
               dw - 24, 10.5)
    mh = 30 + len(mem) * 13.5
    s.rect(dx, my, dw, mh, BG, GREY, 8, 1.2, "5 4")
    line(dx + 12, my + 19, "Только в памяти процесса", dw - 24, 11.5, INK, True)
    for i, ln in enumerate(mem):
        s.text(dx + 12, my + 35 + i * 13.5, ln, 10.5, SOFT)

    # ── база: строки-таблицы со статусами
    rows = [
        ("updates", "in_progress · admitted · ignored · deferred"),
        ("events", "transcribing · new · delivered · processed"),
        ("episodes", "открыт · закрыт · открыт снова"),
        ("buttons · rules_log", "активна · использована · pending → applied"),
        ("meta", "mode · turn · offset · status_line · флаги"),
        ("outbox", "pending · held · sent · dropped"),
        ("deliveries", "посылки: pending → sent · dropped · failed"),
        ("edits · deletions", "pending · sent · dropped"),
        ("reactions", "pending (👀 / 👌; правка — снять) · done · failed"),
    ]
    dy = my + mh + 14
    s.rect(dx, dy, dw, 44, TEAL_L, TEAL, 8, 1.2)
    line(dx + dw / 2, dy + 19, "База SQLite", dw - 20, 13.5, INK, True, "middle")
    line(dx + dw / 2, dy + 35, "пишет шлюз · статус = состояние", dw - 20, 10, SOFT, False, "middle")
    ry = dy + 54
    row_c = {}
    for name, states in rows:
        lines_ = wrap(states, dw - 28, 10.5)
        h = 22 + len(lines_) * 13.5
        s.rect(dx, ry, dw, h, BG, SOFT, 6, 1)
        line(dx + 12, ry + 17, name, dw - 24, 12, INK, True)
        for i, ln in enumerate(lines_):
            s.text(dx + 12, ry + 31 + i * 13.5, ln, 10.5, SOFT)
        row_c[name.split(" ")[0]] = ry + h / 2
        ry += h + 6
    db_bottom = ry - 6

    def link(card_box, x_from, x_to, targets, color=SOFT, marker="a", dash=None):
        """Стрелки от края карточки к строкам базы. Начала разнесены по высоте карточки в порядке строк — веер, а не пучок."""
        top, bot = card_box
        ts = sorted(targets, key=lambda t: row_c[t])
        lo, hi = top + 14, bot - 14
        for i, t in enumerate(ts):
            ty = row_c[t]
            fy = min(max(ty, lo), hi) if len(ts) == 1 else lo + i * (hi - lo) / (len(ts) - 1)
            s.arrow(x_from, fy, x_to, ty, color, dash, marker, 1.3)

    # ── слева: процесс, приём, решения, отправка
    # Стрелки «группа → таблица» — по «Машинам состояний» WORKFLOWS.md: каждая таблица, которую циклы группы меняют
    # (ставят строку, переводят статус, удаляют). Тикер меняет почти все таблицы — у него одна стрелка ко всей базе.
    A = card(lx, gy + 44, lw, "Жизнь процесса", "старт · сигнал остановки · падение · команда stg",
             "отданное delivered → new (кроме той же сессии) · зависшее in_progress → deferred · маркер чистой остановки · stg restore — база из копии",
             ["startup", "token-wait", "crash-recovery", "shutdown", "backup-restore"])
    B = card(lx, A[1] + 22, lw, "Приём из Telegram", "длинный опрос getUpdates (30 с) · команда stg",
             "updates → admitted · событие · эпизод · правка: снять реакцию · offset — одной транзакцией",
             ["reception", "admission", "deferred-retry"])
    D = card(lx, B[1] + 34, lw, "Решения владельца и агента", "команда или кнопка владельца · кадр агента episode, rule",
             "mode и turn · эпизод открыт / закрыт · rules_log · held → pending, «стоп» → dropped (и посылки)",
             ["control", "episodes", "rules"], ORANGE, ORANGE)
    C = card(lx, D[1] + 22, lw, "Отправка в Telegram", "kick от других циклов · свой таймер на ближайший срок",
             "outbox, правки, удаления → sent · посылки — документом · реакции → done · закреплённая строка",
             ["sender-outbox", "sender-edits", "sender-deletions", "status-line", "reactions"])
    link(A, lx + lw, dx, ["updates", "events", "meta", "outbox"])
    link(B, lx + lw, dx, ["updates", "events", "episodes", "meta", "outbox", "reactions"])
    link(D, lx + lw, dx, ["events", "episodes", "buttons", "meta", "outbox", "deliveries", "edits"], ORANGE)
    link(C, lx + lw, dx, ["meta", "outbox", "deliveries", "edits", "reactions"], TEAL, "at")
    s.arrow(lx + 60, B[1], lx + 60, D[0], ORANGE, None, "a", 1.3)
    line(lx + 68, B[1] + 21, "команда, кнопка", lw - 70, 10, MUTED)

    # ── Telegram: владелец и бот
    oy = B[0] + 4
    ol = wrap("пишет текстом, голосом; команды и кнопки", tw_ - 40, 11)
    s.rect(tx + 10, oy, tw_ - 20, max(92, 34 + len(ol) * 14.5), ORANGE_L, ORANGE, 6)
    line(tx + 20, oy + 20, "Владелец", tw_ - 40, 13, INK, True)
    for i, ln in enumerate(ol):
        s.text(tx + 20, oy + 38 + i * 14.5, ln, 11, INK)
    s.arrow(tx + tw_ - 10, oy + 30, lx, oy + 30)
    line((tx + tw_ + gx) / 2, oy + 23, "пишет", gx - tx - tw_ - 3, 9, MUTED, False, "middle")
    by = C[0] + 10
    bl = wrap("ответы и файлы агента, реакции 👀 👌, расшифровки, строка состояния, правки, удаления", tw_ - 40 - PAD, 11)
    s.rect(tx + 10, by, tw_ - 20, 34 + len(bl) * 14.5, CARD, TEAL, 6)
    line(tx + 20, by + 20, "Бот в чате", tw_ - 40, 13, INK, True)
    for i, ln in enumerate(bl):
        s.text(tx + 20, by + 38 + i * 14.5, ln, 11, INK)
    s.arrow(lx, by + 40, tx + tw_ - 10, by + 40, TEAL, None, "at")
    line((tx + tw_ + gx) / 2, by + 33, "отправка", gx - tx - tw_ - 3, 9, MUTED, False, "middle")

    # ── справа: голос, обмен с агентом, наблюдатель agent-state
    F = card(cx_, row_c["events"] - 64, cw, "Голос", "после записи голосового · ответ агента голосом",
             "events: transcribing → new · расшифровка ответом на голосовое, кружок, файл · синтез не вышел — outbox.voice_failed",
             ["stt", "tts"])
    E = card(cx_, F[1] + 22, cw, "Обмен с агентом", "кадры канала · такт 15 с",
             "events: new → delivered → processed · ответ агента в outbox · 👀 и 👌 · флаги связи в meta · картинка агенту — events.media_ref · файл агента — deliveries и копия",
             ["socket-server", "lease", "delivery", "redelivery", "typing", "media", "parcels"])
    V = card(cx_, E[1] + 22, cw, "Наблюдатель agent-state", "файл изменился · опрос 5 с",
             "значки агента в закреплённой строке · строка об отказе модели",
             ["agent-state"])
    link(F, cx_, dx + dw, ["events", "buttons", "outbox", "edits"], TEAL, "at")
    link(E, cx_, dx + dw, ["events", "meta", "outbox", "deliveries", "reactions"], TEAL, "at")
    link(V, cx_, dx + dw, ["meta", "outbox"], TEAL, "at")

    # сокет — граница шлюза у обмена с агентом; подпись — на самой полосе, ниже стрелок к каналу
    sy0, sy1 = E[0] + 6, E[1] - 6
    s.rect(gr - 6, sy0, 12, sy1 - sy0, TEAL, TEAL, 3)
    ky = E[0] + 34
    s.arrow(cx_ + cw, ky, rx + 10, ky, TEAL, None, "at")
    s.arrow(rx + 10, ky + 30, cx_ + cw, ky + 30, SOFT)
    sock_len = width("сокет", 9, True) + PAD
    sock_y = (ky + 30 + 8 + sy1) / 2
    assert sy1 - (ky + 30 + 8) >= sock_len, ("подпись «сокет» не помещается на полосе", sy1 - (ky + 38), sock_len)
    s.add(f'<text x="{gr}" y="{sock_y}" font-size="9" fill="{CARD}" font-weight="700" text-anchor="middle" '
          f'dominant-baseline="central" transform="rotate(-90 {gr} {sock_y})">сокет</text>')

    # ── снаружи справа: канал, Claude Code, agent-state.json
    ch = card(rx + 10, E[0] - 4, rw - 20, "Канал stg-channel", "процесс на сессию; ping 15 с",
              "событие → в сессию; назад delivered, reply, done",
              ["channel-client"])
    ccy = ch[1] + 22
    cc = wrap("сессия агента: модель отвечает инструментами reply, done, episode, rule; смотрит картинки — media; отдаёт файлы — send_file", rw - 44, 10.5)
    cch = 36 + len(cc) * 13.5
    s.rect(rx + 10, ccy, rw - 20, cch, TEAL_L, TEAL, 8, 1.4)
    line(rx + 22, ccy + 21, "Claude Code", rw - 44, 13.5, INK, True)
    for i, ln in enumerate(cc):
        s.text(rx + 22, ccy + 39 + i * 13.5, ln, 10.5, SOFT)
    s.arrow(rx + rw / 2, ch[1], rx + rw / 2, ccy, TEAL, None, "at")
    fy_ = max(ccy + cch + 22, V[0])
    fl = wrap("пишет stg agent-state из строки состояния и перехватчиков Claude Code", rw - 44, 10.5)
    fh = 34 + len(fl) * 13.5
    s.rect(rx + 10, fy_, rw - 20, fh, CARD, TEAL, 8, 1.2)
    line(rx + 22, fy_ + 21, "agent-state.json", rw - 44, 12.5, INK, True)
    for i, ln in enumerate(fl):
        s.text(rx + 22, fy_ + 38 + i * 13.5, ln, 10.5, SOFT)
    s.arrow(rx + rw / 2, ccy + cch, rx + rw / 2, fy_, SOFT)
    assert fy_ + fh <= gb - 8, ("agent-state.json", fy_ + fh, gb)
    s.arrow(rx + 10, fy_ + 50, cx_ + cw, min(max(fy_ + 50, V[0] + 14), V[1] - 14), SOFT)

    # ── снизу по центру: тикер сроков — меняет почти все таблицы, поэтому стрелка ко всей базе (рамка вокруг строк)
    T = card(dx - 20, db_bottom + 40, dw + 40, "Тикер сроков и обслуживание",
             "такт 15 с · сроки раз в минуту · хранение раз в сутки",
             "эпизод → закрыт по тишине · «агент не на связи» · in_progress → deferred через сутки · rules_log → expired · "
             "чистка updates, реакций, удалений · «диск полон» → проба",
             ["ticker", "offline-notice", "purge", "stale-in-progress", "retention", "disk-full"])
    s.rect(dx - 5, dy - 5, dw + 10, db_bottom - dy + 10, "none", TEAL, 10, 1, "3 3")
    s.arrow(dx + dw / 2, T[0], dx + dw / 2, db_bottom + 5, SOFT)
    line(dx + dw / 2 + 8, (db_bottom + 5 + T[0]) / 2 + 4, "ко всей базе", dw / 2 - 8 - PAD, 10, MUTED)
    assert T[1] <= gb - 8, ("тикер не помещается в шлюз", T[1], gb)
    for box, name in ((A, "жизнь процесса"), (B, "приём"), (D, "решения"), (C, "отправка"), (V, "наблюдатель")):
        assert box[1] <= gb - 8, (name, box[1], gb)

    # ── вне кода пакетов: перезапуск процесса
    wy = gb + 16
    s.rect(24, wy, W - 48, 42, CARD, GREY, 8, 1.2, "6 4")
    drawn.add(known("restart-wrapper"))
    line(40, wy + 26, "restart-wrapper — вне кода пакетов: упавший процесс поднимает служба launchd, через 10 с, "
         "без предела попыток", W - 80 - PAD, 11.5, SOFT)
    ly = wy + 66
    drawn.add(known("test-only"))
    line(24, ly, "test-only (сокет часов, сторож родителя) — только под тестом; backup-restore и deferred-retry — по команде. "
         "Реакции шлюза (с 0.3.2): 👀 — событие отдано агенту, 👌 — агент ответил.", W - 48 - PAD, 11, SOFT)
    missing = set(CYCLES) - drawn
    if missing:
        raise SystemExit("циклы таблицы WORKFLOWS.md, которых нет на схеме: " + ", ".join(sorted(missing)))
    if too_wide:
        raise SystemExit("текст шире блока: " + "; ".join(f"«{t}» {a} > {b}" for t, a, b in too_wide))
    s.save("workflows-map.svg")


if __name__ == "__main__":
    message_path()
    responsibilities()
    workflows_map()
    print("ok")
