# MazeCraft — 시연 진행표

출품: Game Direction / Tool Track 없음 / Seoul
주제: A Gift for My Childhood Self — 모래와 물로 놀던 어린 시절의 나에게

## 심사자용 90초 플레이

1. `https://mazecraft.vercel.app/#/tripothon`을 연다.
2. **시연을 1단계부터 시작**을 누른다. 출품 데모 기록만 초기화된다.
3. 오른쪽에서 **연꽃 연못 추가**를 누른다. 준비가 끝나면 재생 속도를 **4×**로 바꾸고 **물 흘려보내기**를 누른다.
4. 실제 물이 종착 연못에 닿으면 **STAGE CLEAR / 별 3개**가 표시된다. **계속 보기**를 누른다.
5. 하단의 배 아이콘 **물에 띄우기 → 고무오리**로 물리 오브젝트를 떨어뜨린다.
6. **일시정지 → 메이즈크래프트 홈 → 챌린지 플레이**. 다음 단계인 대나무의 딱 소리로 재개된다.
7. **홈 → 자유롭게 세계 만들기**. 기본 계단 정원에서 재생을 누르고, 드래그·휠로 정원을 둘러본다.

## 연속 화면 녹화 동선

인트로·선물 대상 → 첫 챌린지의 목표와 잠긴 후속 단계 → 연못을 직접 추가 → 보이는 4× 재생 설정 → 실제 목표 판정과 별 → 고무오리 투입 → 다음 단계 재개 → 자유 제작 계단 정원 → 나뭇잎배·수동 회전·확대 → 일시정지·인트로.

영상은 실제 브라우저 실행을 연속 캡처한다. 제출 MP4는 처음 4분 20초의 단일 연속 구간이며 끝부분만 정리했다. 내부 컷, 대체 렌더, 영상 배속 편집, 음악, 생성 이미지가 없다. 화면 안의 4×는 게임의 물 시뮬레이션 속도다. 캡처 환경은 소프트웨어 WebGL이라 앱이 제공하는 `?post=0` 저사양 렌더 옵션을 사용한다. 업로드 MP4는 무음이다. 플레이어블 데모의 실제 효과음은 스피커 버튼으로 켤 수 있다. GPU 성능에 따라 시뮬레이션 도달 시간은 다를 수 있다.

## 현장 3분 소개 (국문)

“어릴 때 모래 위에 수로를 만들고 물을 부어 본 적이 있습니다. 제가 선물하고 싶은 것은 그때의 실험하는 즐거움입니다. MazeCraft에서는 장치를 붙여 작은 도자기 세계를 만들고 물을 부으면, 내가 만든 구조가 움직입니다. 지금 연못 하나를 추가하겠습니다. 이 챌린지의 조건은 30초 안에 물을 끝까지 보내는 것입니다. 화면의 별은 물 시뮬레이션이 실제로 목표를 달성했을 때 생깁니다. 오리도 넣어 보겠습니다. Rapier 강체가 물의 흐름과 벽에 반응합니다. 다음 단계에서는 대나무 장치의 소리, 나중에는 스크류·노리아·사이펀을 조합해야 합니다. 자유 제작에서는 11개 프리셋을 바꿔 보거나 직접 설계할 수 있습니다. 이 세계는 어린 시절의 나에게 주는, 다시 만들어 보고 싶은 마음의 선물입니다.”

## English controls for judges

| Korean control | Action |
|---|---|
| 시연을 1단계부터 시작 | Reset only this exhibition demo and start stage 1 |
| 연꽃 연못 추가 | Add a lotus pond |
| 물 흘려보내기 / 재생 | Pour water / play |
| 재생 속도 | Simulation speed |
| 계속 보기 / 다음 스테이지 | Continue viewing / next stage |
| 물에 띄우기 → 고무오리 | Drop a floating rubber duck |
| 일시정지 / 물 다시 붓기 | Pause / restart the water |
| 메이즈크래프트 홈 | Return to the exhibition doorway |
| 챌린지 플레이 | Resume the next unlocked unfinished challenge |
| 자유롭게 세계 만들기 | Free building; opens the Terraced Garden |
| 프리셋 둘러보기 | Browse 11 complete world presets |
| 시점 초기화 / 확대 | Reset camera / zoom in |

On mobile, open **장치 목록 열기** to show the device panel. Use two fingers to zoom. For the event, prefer a recent desktop Chrome/Edge browser and a laptop with WebGL enabled. Reloading the exhibition URL returns to the doorway; completed stages remain in this browser. Avoid private browsing if you want progress to persist.

## 현장 준비

온라인 링크를 먼저 연다. 연결이 불안정하면 패키지의 `playable-demo`에서 `python3 serve.py` 또는 `node serve.mjs`를 실행한다. 브라우저가 자동으로 데모 진입 주소를 연다. `index.html`을 직접 더블클릭하지 않는다. 효과음은 현장 음향에 맞춰 스피커 아이콘으로 조절한다. 전체 화면은 브라우저 F11 또는 앱의 몰입 화면을 사용한다.
