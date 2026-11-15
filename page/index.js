/**
 * Таймеры занятий (6 штук, 2×3) + красный таймер на 15 минут. Подробности логики — в shared/core.js.
 *  - Нажатие на эмодзи: запуск; эмодзи полностью заменяется цифрами (минуты 60…1). Нажатие на цифры — пауза (жёлтые).
 *  - Запуск другого таймера: прежний снова становится эмодзи, но помнит свой остаток.
 *  - Пока идёт любой таймер, выйти из приложения нельзя (жесты и кнопки блокируются).
 *  - Час закончился: вибрация, событие уходит на телефон (app-side/index.js), пока телефон не подтвердит — хранится.
 *  - Красный: 15:00 с секундами, один раз. Долгое нажатие на красный — тестовый режим
 *    (час = 10 секунд, красный = 15 секунд; часы засчитываются в трекере по-настоящему).
 */
import { BasePage } from '@zeppos/zml/base-page'
import { createWidget, widget, prop, align, text_style } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { Vibrator, VIBRATOR_SCENE_DURATION_LONG, VIBRATOR_SCENE_STRONG_REMINDER } from '@zos/sensor'
import { setPageBrightTime, pauseDropWristScreenOff, setWakeUpRelaunch } from '@zos/display'
import { LocalStorage } from '@zos/storage'
import * as inter from '@zos/interaction'
import { set as alarmSet, cancel as alarmCancel } from '@zos/alarm'
import * as core from '../shared/core'

const SEND_GAP = 15000        // как часто повторять отправку неподтверждённого события
const USE_ALARM = true        // будить приложение будильником, когда час/15 минут заканчиваются при погасшем экране
const KEEP_AWAKE = true       // пока что-то идёт, не гасить экран
// Поля экрана (в координатах 432 px по ширине). Если что-то всё ещё обрезано — меняйте эти числа:
// LEFT — отступ слева, TOP — сверху, BOTTOM — снизу. Справа поле получается само (экран 432, сетка 380).
const SCREEN_W = 432
const LEFT = 8
const TOP = 56
const BOTTOM = 24
const CELL = 120
const GAP = 10
const WHITE = 0xffffff
const BLACK = 0x050505
const AMBER = 0xffc107
const RED = 0xc62828
const RED_PRESS = 0xe53935

// эмодзи занятий в порядке кнопок; приложение-трекер на телефоне по эмодзи понимает, какому занятию +1 час
const EMOJI = ['\u{1F93F}', '\u{1F3A8}', '\u{1FA78}', '\u{1F4D6}', '\u{1F9EC}', '\u{1F480}', '\u{1F3E0}', '\u{1F340}', '\u{1F50D}']

// Хранилище: если часы его не дают (нет разрешения и т.п.), работаем в памяти и показываем причину на экране
let ls = null
const mem = {}
const store = {
  getItem(k, d) {
    try { if (ls) { const v = ls.getItem(k, d); return v === undefined || v === null ? d : v } } catch (e) { fail('getItem ' + e) }
    return k in mem ? mem[k] : d
  },
  setItem(k, v) {
    mem[k] = v
    try { if (ls) ls.setItem(k, v) } catch (e) { fail('setItem ' + e) }
  }
}

// Ошибки показываем на экране (а не оставляем чёрный экран): без этого на часах их не увидеть
let failed = 0
function fail(msg) {
  failed++
  if (failed > 3) return
  try {
    createWidget(widget.FILL_RECT, { x: 0, y: 0, w: 432, h: 514, color: 0x300000 })
    createWidget(widget.TEXT, {
      x: 12, y: 12 + (failed - 1) * 150, w: 408, h: 140, color: 0xffffff, text_size: 22,
      align_h: align.LEFT, align_v: align.TOP, text_style: text_style.WRAP, text: 'Ошибка ' + failed + ': ' + String(msg).slice(0, 160)
    })
  } catch (e) { /* больше показать нечем */ }
}
function guard(name, f) {
  try { return f() } catch (e) { fail(name + ': ' + e); return undefined }
}

let ST = null          // обычное состояние (хранится)
let STT = null         // тестовое состояние (не хранится)
let testMode = false
let vib = null
let inflight = false
let inflightAt = 0
let timer = null
let ticks = 0
let shown = []         // для каждого квадрата: показана ли кнопка идущего таймера
let lastLabel = []
let lastColor = []
let lastQuick = ''
let lastQuickColor = -1
let idle = []
let runb = []
let quick = null
let dbg = null          // строка диагностики (видна только в тестовом режиме)
let dbgAlarm = 'нет'
let launch = ''         // с каким параметром открыта страница ('alarm' — разбудил будильник)
let lastDbg = ''
let G = null           // геометрия

function cur() { return testMode ? STT : ST }

function save() {
  try {
    store.setItem('st', JSON.stringify(ST))
    store.setItem('tm', testMode ? '1' : '0')
    if (testMode && STT) store.setItem('stt', JSON.stringify(STT))   // тест тоже хранится: приложение может перезапуститься будильником
  } catch (e) { /* без сохранения продолжаем работать */ }
}

function vibrate(mode) {
  try {
    if (!vib) vib = new Vibrator()
    vib.start({ mode: mode })
  } catch (e) {
    try { vib.setMode({ mode: mode }); vib.start() } catch (e2) { /* нет вибромотора */ }
  }
}

function signalHour() { vibrate(VIBRATOR_SCENE_DURATION_LONG) }

function signalQuick() {
  vibrate(VIBRATOR_SCENE_STRONG_REMINDER)
  setTimeout(function () { vibrate(VIBRATOR_SCENE_STRONG_REMINDER) }, 1600)
  setTimeout(function () { vibrate(VIBRATOR_SCENE_STRONG_REMINDER) }, 3200)
}

function geometry() {
  let h = 514
  try {
    const d = getDeviceInfo()
    if (d && d.height > 0) h = Math.min(d.height, 514)
  } catch (e) { /* значения по умолчанию */ }
  // ширина всегда 432 (designWidth приложения): реальная ширина экрана могла быть больше и уводила сетку за край
  const qy = TOP + 2 * CELL + GAP + 14
  const qh = Math.max(60, Math.min(110, h - BOTTOM - qy))
  return { w: SCREEN_W, h: h, cell: CELL, qy: qy, qh: qh, qw: 3 * CELL + 2 * GAP, font: Math.round(CELL * 0.5) }
}

function cellXY(i) {
  const c = i % 3
  const r = Math.floor(i / 3)
  return { x: LEFT + c * (CELL + GAP), y: TOP + r * (CELL + GAP) }
}

function setBtn(b, x, y, w, h, text, color) {
  try { b.setProperty(prop.MORE, { x: x, y: y, w: w, h: h, text: text, color: color }) } catch (e) { /* не критично */ }
}

function setVisible(b, v) {
  try { b.setProperty(prop.VISIBLE, v) } catch (e) { /* не критично */ }
}

/** Перерисовать кнопки по текущему состоянию (меняем только то, что поменялось). */
function render(now) {
  const st = cur()
  for (let i = 0; i < core.COUNT; i++) {
    const isRun = core.running(st, i)
    const show = isRun || core.paused(st, i)
    if (shown[i] !== show) {
      setVisible(idle[i], !show)
      setVisible(runb[i], show)
      shown[i] = show
      lastLabel[i] = ''
    }
    if (show) {
      const text = core.label(st, core.remaining(st, i, now))
      const color = isRun ? WHITE : AMBER
      if (text !== lastLabel[i] || color !== lastColor[i]) {
        const p = cellXY(i)
        setBtn(runb[i], p.x, p.y, G.cell, G.cell, text, color)
        lastLabel[i] = text
        lastColor[i] = color
      }
    }
  }
  const left = core.quickLeft(st, now)
  let qt = core.clock(left)
  if (testMode) qt = 'TEST ' + qt
  const qc = st.q.s === 2 ? AMBER : WHITE
  if (qt !== lastQuick || qc !== lastQuickColor) {
    setBtn(quick, LEFT, G.qy, G.qw, G.qh, qt, qc)
    lastQuick = qt
    lastQuickColor = qc
  }
  renderDebug()
}

function renderDebug() {
  if (!dbg) return
  let t = ''
  if (testMode) {
    t = 'будильник: ' + dbgAlarm + ' | запусков будильником: ' + store.getItem('al', 0) + ' | память: ' + (ls ? 'ок' : 'нет')
  }
  if (t !== lastDbg) {
    lastDbg = t
    try { dbg.setProperty(prop.MORE, { text: t }) } catch (e) { /* не критично */ }
  }
}

function resetView() {
  shown = []
  lastLabel = []
  lastColor = []
  lastQuick = ''
  lastQuickColor = -1
}

/** Будильники на моменты окончания: разбудят приложение, если экран погас. */
function scheduleAlarms(now) {
  if (!USE_ALARM) return
  try {
    const old = JSON.parse(store.getItem('alarms', '[]'))
    for (let k = 0; k < old.length; k++) { try { alarmCancel(old[k]) } catch (e) { /* уже сработал */ } }
  } catch (e) { /* нет старых */ }
  const ids = []
  const due = core.nextDue(cur())
  dbgAlarm = due.length ? '?' : 'нет'
  for (let k = 0; k < due.length; k++) {
    const delay = Math.max(1, Math.ceil((due[k].t - now) / 1000) + 1)
    try {
      const id = alarmSet({ url: 'page/index', param: 'alarm', delay: delay })
      if (id) { ids.push(id); dbgAlarm = 'ок ' + delay + 'с' } else { dbgAlarm = 'отказ(' + id + ')' }
    } catch (e) { dbgAlarm = 'ошибка ' + String(e).slice(0, 30) }
  }
  try { store.setItem('alarms', JSON.stringify(ids)) } catch (e) { /* не критично */ }
}

function keepAwake() {
  if (!KEEP_AWAKE || !core.anyRunning(cur())) return
  try { setPageBrightTime({ brightTime: 120000 }) } catch (e) { /* не критично */ }
  try { pauseDropWristScreenOff({ duration: 600000 }) } catch (e) { /* не критично */ }
}

/** Пока идёт таймер, выйти из приложения нельзя: гасим жесты и кнопки (true — «система, не обрабатывай»). */
function blockExit() {
  try {
    inter.onGesture({
      callback: function (e) {
        if (!core.anyRunning(cur())) return false
        return e === inter.GESTURE_RIGHT || e === inter.GESTURE_LEFT || e === inter.GESTURE_UP || e === inter.GESTURE_DOWN
      }
    })
  } catch (e) { /* без блокировки жестов */ }
  try {
    inter.onKey({
      callback: function (key, keyEvent) {
        if (!core.anyRunning(cur())) return false
        return key === inter.KEY_BACK || key === inter.KEY_HOME || key === inter.KEY_SELECT || key === inter.KEY_SHORTCUT
      }
    })
  } catch (e) { /* без блокировки кнопок */ }
}

Page(
  BasePage({
    onInit(p) {
      try { if (!ls) ls = new LocalStorage() } catch (e) { /* ошибка покажется в build */ }
      launch = typeof p === 'string' ? p : ''
      if (launch === 'alarm') {
        try { store.setItem('al', (+store.getItem('al', 0) || 0) + 1) } catch (e) { /* не критично */ }
      }
    },

    build() {
      guard('старт', () => { ls = new LocalStorage() })
      G = guard('экран', geometry)
      guard('открытие', () => setWakeUpRelaunch({ relaunch: true }))   // при включении экрана открывается это приложение
      ST = guard('состояние', () => core.restore(store.getItem('st', ''), false)) || core.newState(false)
      testMode = store.getItem('tm', '0') === '1'
      STT = testMode ? core.restore(store.getItem('stt', ''), true) : null
      blockExit()
      resetView()
      idle = []
      runb = []

      for (let i = 0; i < core.COUNT; i++) {
        const k = i
        guard('кнопка ' + i, () => {
          const p = cellXY(i)
          idle.push(createWidget(widget.BUTTON, {
            x: p.x, y: p.y, w: G.cell, h: G.cell, text: '', normal_src: 'i' + i + '.png', press_src: 'i' + i + '.png',
            click_func: () => { guard('нажатие', () => this.cellTap(k)) }
          }))
          // идущий таймер: только цифры на чёрном, эмодзи полностью скрыто
          const rb = createWidget(widget.BUTTON, {
            x: p.x, y: p.y, w: G.cell, h: G.cell, text: '60', text_size: G.font, color: WHITE,
            normal_color: BLACK, press_color: 0x1c1c1c, radius: 0,
            click_func: () => { guard('нажатие', () => this.cellTap(k)) }
          })
          setVisible(rb, false)
          runb.push(rb)
        })
      }
      guard('красная кнопка', () => {
        quick = createWidget(widget.BUTTON, {
          x: LEFT, y: G.qy, w: G.qw, h: G.qh, text: '15:00', text_size: Math.round(G.qh * 0.5), color: WHITE,
          normal_color: RED, press_color: RED_PRESS, radius: Math.round(G.qh * 0.25),
          click_func: () => { guard('красная', () => this.quickTap()) },
          longpress_func: () => { guard('тест', () => this.toggleTest()) }
        })
      })

      guard('диагностика', () => {
        dbg = createWidget(widget.TEXT, {
          x: LEFT, y: G.qy + G.qh + 8, w: G.qw, h: 60, color: 0x808080, text_size: 20,
          align_h: align.LEFT, align_v: align.TOP, text_style: text_style.WRAP, text: ''
        })
      })

      const now = Date.now()
      guard('запуск', () => this.settle(core.process(ST, now), now))   // то, что закончилось, пока приложение было закрыто
      if (launch === 'alarm') { try { setPageBrightTime({ brightTime: 20000 }) } catch (e) { /* не критично */ } }
      timer = setInterval(() => { guard('секунда', () => this.tick()) }, 1000)
    },

    onDestroy() {
      if (timer) { clearInterval(timer); timer = null }
      save()
    },

    /** Всё, что нужно сделать после любого изменения состояния. */
    settle(res, now) {
      if (res.fresh) signalHour()
      if (res.quickDone && res.quickFresh) signalQuick()
      save()
      scheduleAlarms(now)
      keepAwake()
      render(now)
      this.sendDue(now)
    },

    tick() {
      const now = Date.now()
      ticks++
      const res = core.process(cur(), now)
      if (res.events.length || res.quickDone) {
        this.settle(res, now)
      } else {
        render(now)
        this.sendDue(now)
        if (ticks % 60 === 0) keepAwake()
      }
    },

    cellTap(i) {
      const now = Date.now()
      this.settle(core.toggle(cur(), i, now), now)
    },

    quickTap() {
      const now = Date.now()
      this.settle(core.quickTap(cur(), now), now)
    },

    /** Долгое нажатие на красный: войти в тестовый режим или выйти из него. */
    toggleTest() {
      testMode = !testMode
      STT = testMode ? core.newState(true) : null
      if (!testMode) { try { store.setItem('stt', '') } catch (e) { /* не критично */ } }
      resetView()
      const now = Date.now()
      // при возврате в обычный режим учитываем, что прошло за время теста
      this.settle(core.process(cur(), now), now)
      signalHour()
    },

    /** Отправить телефону одно неподтверждённое событие (по одному за раз). */
    sendDue(now) {
      if (inflight && now - inflightAt < 30000) return
      const states = testMode ? [ST, STT] : [ST]
      let target = null
      let owner = null
      for (let s = 0; s < states.length && !target; s++) {
        const d = core.due(states[s], now, SEND_GAP)
        if (d.length) { target = d[0]; owner = states[s] }
      }
      if (!target) return
      target.tried = now
      inflight = true
      inflightAt = now
      const id = target.id
      // и настоящие часы, и часы тестового режима уходят как «done» с эмодзи: в тесте час засчитывается в трекере
      const payload = { t: 'done', id: id, e: EMOJI[target.i], ts: target.ts }
      this.request({ method: 'u613.send', params: payload })
        .then((res) => {
          inflight = false
          const r = res && res.ok ? res.reply : null
          if (r && r.t === 'ack' && r.id === id) {
            core.ack(owner, id)
            save()
            this.sendDue(Date.now())
          }
        })
        .catch(() => { inflight = false })
    }
  })
)
