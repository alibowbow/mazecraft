# MazeCraft · 메이즈크래프트

> 풀어야만 열리는 이야기

MazeCraft Core 1.0은 브라우저 안에서 실루엣 미로를 만들고, 품질을 검증하고, 직접 플레이한 뒤 링크나 파일로 공유하는 로컬 퍼스트 웹앱입니다. 회원가입이나 서버 데이터베이스 없이 기본 도형, 텍스트, 사용자가 올린 이미지와 직접 그린 형태만 사용합니다.

## 주요 기능

- 17가지 로컬 벡터 도형, 여러 줄 텍스트, 이미지 전처리, 직접 그리기
- 재현 가능한 seed 기반 DFS·Kruskal·Prim 생성과 Web Worker 후보 비교
- DFS 탐색·Kruskal 벽 제거·Prim 영역 확장 생성 리플레이와 경로·2D 물·파티클 풀이 애니메이션
- Three.js 기반 3D 물 미로: 최상단 S에서 주입해 모든 열린 통로로 분기하고 최하단 E로 배출
- 위쪽 입구·아래쪽 출구 자동 최적화, Maze IQ 지표, 연결성·벽 대칭 검증과 자동 복구
- 벽 열기·닫기, 시작/종료점·아이템·체크포인트 편집, 100단계 실행 취소/다시 실행
- IndexedDB 프로젝트 저장, 변경 후 자동 저장, 새로고침 복구, `.mazecraft` 가져오기
- 시크릿 메시지·이미지·링크·쿠폰·장소 힌트와 단계별 공개
- 키보드·드래그·스와이프·D-pad 플레이, 타임어택, 힌트, 개인 기록, 제작자 고스트
- 압축 공유 링크, QR, Web Share, 새 창 플레이, 원클릭 리믹스
- PNG·SVG·A4 문제지/정답지·프로젝트 파일·결과 카드·독립 실행 HTML 출력
- 라이트/다크 모드, 키보드 접근성, 모바일 핀치/이동, 애니메이션 감소 설정

## 실행

Node.js 20 이상을 권장합니다.

```bash
npm ci
npm run dev
```

개발 서버가 안내하는 로컬 주소를 브라우저에서 여세요.

## 빌드

```bash
npm run build
npm run preview
```

프로덕션 파일은 `dist/`에 생성됩니다. 정적 호스팅 시 `index.html`과 `assets/`를 같은 위치에 배치하면 됩니다. 라우팅은 URL hash를 사용하므로 별도 서버 rewrite 규칙이 필요하지 않습니다.

## 테스트

```bash
# TypeScript 검사
npm run lint

# 단위·통합 테스트
npm test

# 최초 1회 브라우저 설치
npx playwright install chromium

# 실제 브라우저 E2E
npm run test:e2e
```

E2E는 제작, 재생성, 플레이·완주, 시크릿 공개, 자동 저장 복구, 파일 가져오기/내보내기, 공유 링크, 리믹스, 편집 이력, PNG·SVG 출력, 3D 물 흐름, 모바일 레이아웃과 외부 요청 부재를 확인합니다.

## 프로젝트 데이터 구조

프로젝트의 원본은 Canvas 픽셀이 아니라 셀과 벽으로 이루어진 그래프입니다.

| 영역 | 주요 데이터 |
| --- | --- |
| 식별·버전 | `schemaVersion`, `appVersion`, `id`, `createdAt`, `updatedAt` |
| 제작 설정 | `seed`, `canvas`, `grid`, `shape`, `mask` |
| 미로 | `mazeGraph`, `startCell`, `endCell`, `difficulty`, `mazeMetrics` |
| 게임 | `gameRules`, `collectibles`, `checkpoints`, `creatorReplay` |
| 표현 | `visualTheme`, `background`, `secretReveal` |
| 공유·출력 | `remixAllowed`, `creatorDisplayName`, `exportSettings`, `attribution` |

`mazeGraph.cells`는 행 우선 순서로 저장되며 각 셀은 활성 여부와 상·우·하·좌 벽 상태를 가집니다. 가져오기 시 스키마 버전을 검사하고, 지원 가능한 이전 형식은 현재 스키마로 마이그레이션합니다.

## 저장 방식

- IndexedDB: 프로젝트 본문과 선택적 Blob 자산
- localStorage: 테마, 마지막 프로젝트, 개인 최고 기록과 최근 도전 기록
- 자동 저장: 변경을 모아 debounce한 뒤 저장하고 `pagehide`에서 마지막 초안을 기록
- 저장소 추상화: `ProjectRepository`와 `ProjectAssetRepository` 인터페이스 뒤에 로컬 구현을 배치

향후 서버 저장을 추가할 때는 저장소 인터페이스 구현을 교체하고, 제작·플레이 UI와 미로 엔진은 그대로 유지할 수 있습니다.

## 공유 링크

공유 데이터는 셀당 5비트 그래프 패킹 후 DEFLATE로 압축하고 URL-safe Base64로 변환해 다음 hash에 넣습니다.

```text
/#/play?data=압축된데이터
```

공유 링크로 열면 홈이나 편집기를 거치지 않고 플레이 화면으로 진입합니다. 해답, 제작자 고스트, 제작자 표시명과 리믹스 허용 여부는 공유 전에 선택할 수 있습니다.

안전 한도는 전체 URL 2,000자입니다. 이를 넘으면 링크와 QR 생성을 중단하고 `.mazecraft` 파일 또는 독립 실행 HTML 사용을 안내합니다. 큰 이미지나 긴 고스트는 링크 한도를 빠르게 소모합니다.

## 독립 실행 HTML

공유 단계의 파일 내보내기에서 `독립 실행 HTML`을 선택하면 미로 그래프, 플레이어, 스타일, 시크릿 콘텐츠와 선택한 고스트가 한 파일에 포함됩니다. 다운로드한 파일은 인터넷 연결 없이 열어 키보드, 스와이프와 D-pad로 플레이할 수 있습니다. 이 파일은 플레이 전용이며 편집 프로젝트로 다시 가져오지 않습니다.

## 지원 브라우저

- 최신 두 버전의 Chrome, Edge, Firefox
- Safari 16.4 이상
- IndexedDB, Web Worker, Canvas 2D, WebGL 2, Blob URL을 지원하는 최신 모바일 브라우저

`navigator.share`가 없는 데스크톱 브라우저에서는 링크 복사와 QR을 사용합니다. 3D 물 시뮬레이션은 처음 열 때만 Three.js 모듈을 지연 로드하며 저사양 기기에서는 메시와 렌더링 해상도를 자동으로 낮춥니다. 운영체제의 파일 URL 정책이 엄격한 환경에서는 독립 HTML을 로컬 정적 서버로 열어야 할 수 있습니다.

## 실제 제한사항

- 공유 링크는 전체 2,000자까지만 생성합니다.
- 브라우저가 IndexedDB를 차단하면 메모리 저장소로 전환되며 해당 탭을 닫으면 유지되지 않습니다.
- PNG는 브라우저 메모리 보호를 위해 한 변 16,384px, 전체 64MP 이하로 제한합니다.
- 독립 실행 HTML은 부분 셀 마스크 공개 대신 완주 시 전체 시크릿 공개를 사용합니다.
- WebGL을 사용할 수 없거나 그래픽 컨텍스트가 종료되면 3D 물 화면을 닫고 기존 2D 물 애니메이션을 사용할 수 있습니다.
- 서버 순위표, 계정 동기화, 실시간 멀티플레이와 대용량 미디어 호스팅은 포함하지 않습니다.
