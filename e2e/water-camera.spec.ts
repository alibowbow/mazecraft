import { expect, test, type Locator } from '@playwright/test'
import { Quaternion, Vector3 } from 'three'
import {
  branchingWaterProject, importWaterProject, numberAttribute,
  openParticleWater, pauseWater, readWaterState,
} from './helpers/waterHarness'

async function cameraPose(canvas: Locator) {
  const pose = await canvas.evaluate(element => ({
    orientation: element.getAttribute('data-camera-orientation')!.split(',').map(Number),
    target: element.getAttribute('data-camera-target')!.split(',').map(Number),
    view: element.getAttribute('data-camera-view')!.split(',').map(Number),
  }))
  return { orientation: new Quaternion().fromArray(pose.orientation), target: new Vector3().fromArray(pose.target), view: pose.view }
}

test('15. 3D 터치 회전·이동·확대가 손가락을 따르고 정지된 물 상태를 보존한다', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await importWaterProject(page, branchingWaterProject, 'high', true)
  const stage = await openParticleWater(page, 'surface-3d')
  await expect.poll(() => numberAttribute(stage, 'data-elapsed-ms')).toBeGreaterThan(500)
  await pauseWater(page, stage)
  const state = await readWaterState(stage)
  const canvas = stage.locator('canvas.water-simulation-canvas')
  const fieldBuilds = await canvas.getAttribute('data-surface-builds')
  const initialFrame = await canvas.screenshot()
  const box = (await canvas.boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  const initialPose = await cameraPose(canvas)
  const cdp = await page.context().newCDPSession(page)
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
  const drag = async (dx: number, dy: number) => {
    await touch('touchStart', [{ x: cx, y: cy, id: 1 }])
    await touch('touchMove', [{ x: cx + dx, y: cy + dy, id: 1 }])
    await touch('touchEnd', [])
  }
  const direction = (pose: Awaited<ReturnType<typeof cameraPose>>) => new Vector3(0, 0, 1).applyQuaternion(pose.orientation)
  const step = Math.min(box.width, box.height)
  await drag(step * 0.12, 0)
  let pose = await cameraPose(canvas)
  const grabbed = direction(initialPose).applyQuaternion(pose.orientation.clone().invert())
  expect(grabbed.x).toBeGreaterThan(0.1)
  expect(Math.abs(grabbed.y)).toBeLessThan(0.001)
  const beforeDown = pose
  await drag(0, step * 0.12)
  pose = await cameraPose(canvas)
  const grabbedDown = direction(beforeDown).applyQuaternion(pose.orientation.clone().invert())
  expect(grabbedDown.y).toBeLessThan(-0.1)
  expect(Math.abs(grabbedDown.x)).toBeLessThan(0.001)

  // Repeated grabs pass the old narrow yaw limit and reach the back freely.
  for (let i = 0; i < 4; i++) await drag(step * 0.32, 0)
  pose = await cameraPose(canvas)
  expect(direction(pose).dot(direction(initialPose))).toBeLessThan(-0.5)
  expect(pose.view).toEqual(initialPose.view)
  expect((await canvas.screenshot()).equals(initialFrame)).toBe(false)

  // Even from the back, a translated two-finger pair moves the board by the
  // same screen pixels, without accidentally rotating it or changing scale.
  const beforePan = pose
  const separation = Math.min(35, step * 0.15)
  const dx = 22, dy = 16
  await touch('touchStart', [{ x: cx - separation, y: cy, id: 1 }, { x: cx + separation, y: cy, id: 2 }])
  await touch('touchMove', [{ x: cx - separation + dx, y: cy + dy, id: 1 }, { x: cx + separation + dx, y: cy + dy, id: 2 }])
  await touch('touchEnd', [])
  pose = await cameraPose(canvas)
  expect(pose.orientation.angleTo(beforePan.orientation)).toBeLessThan(1e-6)
  expect(pose.view[0]).toBeCloseTo(beforePan.view[0], 8)
  const panDelta = beforePan.target.clone().sub(pose.target).applyQuaternion(pose.orientation.clone().invert())
  expect(panDelta.x / pose.view[0] * box.width).toBeCloseTo(dx, 0)
  expect(-panDelta.y / pose.view[1] * box.height).toBeCloseTo(dy, 0)

  const beforeZoom = pose
  const anchor = new Vector3(dx / box.width * pose.view[0], -dy / box.height * pose.view[1], 0)
    .applyQuaternion(pose.orientation).add(pose.target)
  await touch('touchStart', [{ x: cx + dx - separation, y: cy + dy, id: 1 }, { x: cx + dx + separation, y: cy + dy, id: 2 }])
  await touch('touchMove', [{ x: cx + dx - separation * 1.4, y: cy + dy, id: 1 }, { x: cx + dx + separation * 1.4, y: cy + dy, id: 2 }])
  await touch('touchEnd', [])
  pose = await cameraPose(canvas)
  expect(pose.view[0]).toBeLessThan(beforeZoom.view[0] * 0.8)
  const zoomAnchor = anchor.sub(pose.target).applyQuaternion(pose.orientation.clone().invert())
  expect(zoomAnchor.x / pose.view[0] * box.width).toBeCloseTo(dx, 0)
  expect(-zoomAnchor.y / pose.view[1] * box.height).toBeCloseTo(dy, 0)

  // Mouse input shares the direct-grab mapping; Shift is camera-plane pan.
  const beforeMouse = pose
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx - step * 0.12, cy)
  await page.mouse.up()
  pose = await cameraPose(canvas)
  expect(direction(beforeMouse).applyQuaternion(pose.orientation.clone().invert()).x).toBeLessThan(-0.1)
  await expect(canvas).toHaveAttribute('data-surface-builds', fieldBuilds!)
  expect(await readWaterState(stage)).toEqual(state)
  await page.getByRole('dialog').getByRole('button', { name: '화면 맞춤', exact: true }).click()
  expect((await cameraPose(canvas)).view).toEqual(initialPose.view)
  const finalFrame = await canvas.screenshot()
  await page.waitForTimeout(250)
  expect((await canvas.screenshot()).equals(finalFrame)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('water-3d-direct-touch.png') })
  expect(errors).toEqual([])
})
