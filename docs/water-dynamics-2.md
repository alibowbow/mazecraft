# Water Dynamics 2.0

MazeCraft의 3D 물은 완전한 Navier–Stokes, FLIP, SPH 또는 FFT 유체 해석이 아니다. 미로의 활성 셀을 저장 용량을 가진 control volume으로, 열린 통로를 유량 상태를 가진 hydraulic edge로 해석하는 동적 수두–유량 네트워크 모델이다. 셀 수위와 통로 유량은 고정 시간 간격으로 실제 적분되며, 미래의 도착 시각이나 채움 시각을 미리 계산하지 않는다.

## 좌표와 단위

내부 계산은 SI 단위를 사용한다.

| 값 | 단위 | 기본값 | 의미 |
| --- | --- | --- | --- |
| 길이 | m | — | 셀·통로·수심의 내부 단위 |
| 시간 | s | — | 물리 적분 시간 |
| `g` | m/s² | 9.81 | 중력 가속도 |
| 셀 폭 | m | 1.0 | 한 셀의 가로 길이 |
| 셀 높이 | m | 0.18 | 인접 행 사이의 고도 차이 |
| 수로 두께 | m | 0.12 | 화면 밖 방향의 유효 두께 |
| 저장 면적 | m² | 셀 폭 × 수로 두께 | `depth = volume / storageArea` |
| 통로 폭 | m | 0.58 | 벽 사이의 유효 개구 폭 |
| 통로 길이 | m | 셀 간 중심 거리 | 유량 관성 항의 길이 |
| 마찰 계수 | — | 1.15 | 축약형 손실 항 |

미로 행 번호는 화면 아래로 갈수록 커지고, 고도는 낮아진다.

```text
z_i = (rows - 1 - row_i) * cellHeight
h_i = V_i / storageArea_i
H_i = z_i + h_i
```

`V_i`는 셀에 저장된 부피, `h_i`는 등가 수심, `H_i`는 자유수면 hydraulic head다. 렌더링 텍스처에 기록하기 직전에만 깊이와 속도를 0–1 또는 -1–1 범위로 정규화한다.

## 네트워크 상태

각 활성 셀은 다음 `Float64Array` 상태를 가진다.

- 부피 `V`
- 수심 `h`
- 수두 `H`
- 순유입량
- 압력 대용값

각 열린 통로는 다음 상태를 가진다.

- 기준 `from → to` 방향에 대한 signed discharge `Q`
- 유속
- hydraulic resistance
- 현재 유효 개구 면적
- sill elevation
- 양 끝 node index

edge의 저장 방향은 계산 순서를 위한 기준일 뿐 실제 흐름 방향이 아니다. 양 끝 수두가 바뀌면 `Q`의 부호가 바뀌어 역류할 수 있다.

## 지배식과 개구

노드의 연속방정식은 다음과 같다.

```text
dV_i/dt = source_i - outlet_i + Σ incoming Q - Σ outgoing Q
```

통로 유량은 축약형 관성–마찰 방정식으로 적분한다.

```text
dQ_e/dt = g A_e / L_e (H_a - H_b) - friction_e(Q_e) - damping_e(Q_e)
```

유효 개구 면적은 upstream 자유수면이 sill을 넘는 정도에 따라 연속적으로 증가한다. sill 아래에서는 거의 닫히고, sill 위에서는 잠긴 높이와 통로 폭으로 면적을 계산한다. “아래 셀이 모두 찼으면 위로 이동” 같은 별도 boolean 규칙은 사용하지 않는다.

상단 저장조는 화면의 연속 낙하 유입과 맞도록 ramp-up prescribed inflow 경계로 모델링한다. 물줄기가 셀에 닿기 전에는 source를 끄고, 충돌 시점을 물리 시간 0초로 삼아 0.75초 동안 0에서 목표 유량 `0.018 m³/s`까지 선형으로 올린다. 테스트와 배수 실험을 위해 source를 다시 끌 수 있다.

하단 배출구는 자유수면 head에 반응하는 orifice 경계를 사용한다. 기본 방출 계수 `C_d`는 0.62, 개구 면적 `A_open`은 `0.04 m²`, 외부 경계 수두는 출구 셀 바닥 고도다.

```text
Q_out = C_d A_open sqrt(2 g max(H_exit - H_boundary, 0))
```

따라서 출구 폭포는 도착 이벤트 뒤 고정 세기로 켜지는 효과가 아니라 실제 출구 수두와 유량에 반응한다.

## 적분과 안정성

- 기본 physics step은 1/120초다.
- 프레임 시간과 물리 step은 분리한다.
- 0.1×, 0.5×, 1×, 2×, 4×는 큰 `dt`를 한 번 적용하지 않고 동일한 작은 step을 처리하는 양만 바꾼다.
- 각 substep에서 한 노드의 모든 outward flux를 함께 제한해 보유 부피보다 많은 물이 빠져나가지 않게 한다.
- 모든 edge flux는 이전 상태에서 계산한 뒤 노드 변화량에 동시에 적용해 배열 순서 편향을 막는다.
- 기본 선형 유량 감쇠는 `2.4 s⁻¹`이며, 한 substep에 사용 가능한 부피의 최대 92%만 내보내도록 flux를 제한한다.
- 축약 모델의 안전 상한은 edge 유속 `7.5 m/s`다. 이 값은 실제 자유수면의 정밀 한계가 아니라 비정상 입력에서 수치 발산을 막는 방어선이다.
- 부피는 음수가 될 수 없으며 NaN 또는 Infinity가 발견되면 즉시 명확한 오류를 낸다.
- topology와 CSR adjacency는 초기화할 때 한 번 만들고, step마다 객체·`Map`·`Set`·임시 배열을 만들지 않는다.

- 압력·중력 항은 명시적으로, 선형·2차 항력은 backward Euler로 푼다. 2차 방정식을 닫힌 형태로 풀기 때문에 step이나 저항이 커도 항력이 0을 넘어 유속 방향을 뒤집지 않는다.
- 얇은 수막에는 수심에 따른 추가 저항을, 각 portal 유속에는 `Fr · sqrt(g h)` 기반 국소 상한을 적용해 젖고 마르는 경계를 안정화한다.

3D 미로 수조(`freeSurface/basinSimulation.ts`)는 이 네트워크를 main thread에서 고정 1/120초 step으로 적분하고, 화면 프레임마다 밀린 시간만큼 step을 진행한다. 저화질과 고화질은 시각 비용만 다르며 물리 결과는 같다.

## 질량 보존 진단

누적 유입량과 누적 배출량은 각 경계의 실제 유량을 시간 적분한다. 진단 시점마다 저장량을 node volume에서 새로 합산한다.

```text
expectedMass = initialStoredVolume
             + cumulativeInjectedVolume
             - cumulativeOutletVolume

actualMass = Σ nodeVolume
absoluteMassError = abs(expectedMass - actualMass)
relativeMassError = absoluteMassError
                  / max(expectedMass, actualMass, epsilon)
```

일반 크기 fixture의 60초 상당 실행에서 `relativeMassError < 1e-5`를 유지한다. 저장량과 잔류량의 차이를 배출량으로 다시 정의해 보존을 증명하지 않는다.

## 렌더링과 수명 주기

물의 렌더링, 2D 입자 Worker, 일시정지·재시작·탭 숨김 처리와 자원 정리는 [자유수면 물 시뮬레이션](free-surface-water.md)에 정리되어 있다. 이 문서의 네트워크와 solver는 그 런타임의 3D 미로 수조가 사용한다. 물의 정원 프리셋과 크래프트는 `garden/physics`의 수심 평균 천수(shallow-water) 격자 모델을 따로 쓴다.
