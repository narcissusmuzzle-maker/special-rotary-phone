import assert from 'node:assert'
import * as core from '../shared/core.js'

const T = 1000000   // run=0 означает «не идёт», поэтому время в тестах начинаем не с нуля
let n = 0
function t(name, f) { f(); n++; console.log('ok  ' + name) }

t('шесть занятий', () => assert.equal(core.COUNT, 6))

t('обычный час: событие через 60 минут, id без x', () => {
  const st = core.newState(false)
  core.toggle(st, 0, T)
  assert.equal(core.process(st, T + 59 * 60000).events.length, 0)
  const r = core.process(st, T + 60 * 60000)
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0].id, '0-' + (T + 3600000))
  assert.equal(r.fresh, true)
})

t('тест: час = 10 секунд, событие считается по-настоящему (id без x)', () => {
  const st = core.newState(true)
  core.toggle(st, 2, T)
  assert.equal(core.label(st, core.remaining(st, 2, T)), '10')
  assert.equal(core.label(st, core.remaining(st, 2, T + 4200)), '6')
  const r = core.process(st, T + 10000)
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0].id, '2-' + (T + 10000))
  assert.equal(st.out.length, 1)
  // отсчёт пошёл заново
  assert.equal(core.remaining(st, 2, T + 10000), 10000)
  // за ещё 25 секунд (экран был выключен) — ещё два часа
  assert.equal(core.process(st, T + 35000).events.length, 2)
})

t('тест: красный = 15 секунд', () => {
  const st = core.newState(true)
  core.quickTap(st, T)
  assert.equal(core.clock(core.quickLeft(st, T)), '00:15')
  assert.equal(core.clock(core.quickLeft(st, T + 5000)), '00:10')
  const r = core.process(st, T + 15000)
  assert.equal(r.quickDone, true)
  assert.equal(st.q.s, 2)
  assert.deepEqual(core.nextDue(core.newState(true)), [])
})

t('обычный красный = 15:00', () => {
  const st = core.newState(false)
  core.quickTap(st, T)
  assert.equal(core.clock(core.quickLeft(st, T)), '15:00')
  assert.equal(core.nextDue(st)[0].t, T + 15 * 60000)
})

t('переключение: прежний таймер снова эмодзи, остаток сохраняется', () => {
  const st = core.newState(false)
  core.toggle(st, 0, T)
  core.toggle(st, 1, T + 10 * 60000)           // через 10 минут включили другой
  assert.equal(core.running(st, 0), false)
  assert.equal(core.paused(st, 0), false)      // цифры не показываем — эмодзи
  assert.equal(core.running(st, 1), true)
  assert.equal(st.rem[0], 50 * 60000)          // остаток помнит
  core.toggle(st, 0, T + 20 * 60000)           // вернулись к первому — продолжает с 50
  assert.equal(core.label(st, core.remaining(st, 0, T + 20 * 60000)), '50')
  assert.equal(core.running(st, 1), false)
})

t('пауза нажатием: жёлтые цифры остаются; запуск другого их убирает', () => {
  const st = core.newState(false)
  core.toggle(st, 3, T)
  core.toggle(st, 3, T + 5 * 60000)            // пауза нажатием
  assert.equal(core.paused(st, 3), true)
  assert.equal(core.label(st, core.remaining(st, 3, T + 6 * 60000)), '55')
  core.toggle(st, 4, T + 6 * 60000)
  assert.equal(core.paused(st, 3), false)
  assert.equal(st.rem[3], 55 * 60000)
})

t('сохранение и восстановление (в том числе старое сохранение на 9 занятий)', () => {
  const st = core.newState(false)
  core.toggle(st, 1, T + 100)
  core.toggle(st, 1, T + 200)
  const back = core.restore(JSON.stringify(st), false)
  assert.equal(back.hold, 1)
  assert.equal(back.rem[1], st.rem[1])
  const old = JSON.stringify({ v: 2, rem: Array(9).fill(core.FULL).map((x, i) => i === 7 ? 1000 : x), run: Array(9).fill(0), q: { s: 0, run: 0 }, out: [] })
  const r = core.restore(old, false)
  assert.equal(r.rem.length, 6)
  assert.equal(r.rem[0], core.FULL)
  const tst = core.restore(JSON.stringify(core.newState(true)), true)
  assert.equal(tst.test, true)
  assert.equal(tst.full, 10000)
})

t('подтверждение убирает событие из очереди', () => {
  const st = core.newState(false)
  core.toggle(st, 0, T)
  const r = core.process(st, T + 3600000)
  assert.equal(core.due(st, T + 3600000, 15000).length, 1)
  core.ack(st, r.events[0].id)
  assert.equal(st.out.length, 0)
})

console.log(n + ' tests passed')
