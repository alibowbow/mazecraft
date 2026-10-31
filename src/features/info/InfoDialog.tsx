import { useEffect, useRef, useState } from 'react'
import { ExternalLink, HardDriveDownload, HardDriveUpload, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Dialog } from '../dialogs/Dialog'
import { versionLabel } from '../../app/appInfo'
import { backupFileName, createBackup } from '../backup/backup'
import { downloadBlob } from '../export/download'
import {
  formatBytes,
  localProjectRepository,
  readStorageState,
  requestPersistentStorage,
  type ColorTheme,
  type EffectQuality,
  type StorageState,
} from '../../storage'
import './info.css'

export type InfoTab = 'help' | 'settings' | 'data' | 'about'

const TABS: Array<[InfoTab, string]> = [
  ['help', '사용 방법'],
  ['settings', '설정'],
  ['data', '저장과 개인정보'],
  ['about', '앱 정보'],
]

const CREDITS: Array<[string, string]> = [
  ['React', 'MIT'],
  ['three.js', 'MIT'],
  ['Rapier (@dimforge/rapier3d-compat)', 'Apache-2.0'],
  ['Lucide 아이콘', 'ISC'],
  ['Pretendard 글꼴', 'SIL Open Font License 1.1'],
  ['Clipper (clipper-lib)', 'Boost Software License 1.0'],
  ['fflate', 'MIT'],
  ['node-qrcode', 'MIT'],
]

interface Props {
  initialTab?: InfoTab
  onClose(): void
  theme: ColorTheme
  onThemeChange(theme: ColorTheme): void
  quality: EffectQuality
  onQualityChange(quality: EffectQuality): void
  storageVolatile: boolean
  projectCount: number
  /** Restore a backup (or open a project file). */
  onRestore(file: File): Promise<void>
  onToast(message: string, error?: boolean): void
}

function Choice<T extends string>({ label, value, options, onChange }: {
  label: string
  value: T
  options: Array<[T, string]>
  onChange(value: T): void
}) {
  return (
    <div className="info-choice" role="group" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>{text}</button>
      ))}
    </div>
  )
}

function HelpTab() {
  return (
    <div className="info-section">
      <section>
        <h3>미로 제작</h3>
        <ol>
          <li><strong>새 미로 만들기</strong>나 시작 방식 하나를 고릅니다.</li>
          <li><strong>모양</strong> 단계에서 도형·글자·이미지·직접 그리기로 윤곽을 정합니다.</li>
          <li><strong>미로</strong> 단계에서 크기와 난이도를 고르고 벽을 직접 열고 닫습니다.</li>
          <li><strong>완성</strong> 단계에서 직접 플레이해 보고 링크·QR·파일로 공유합니다.</li>
        </ol>
        <p>모든 변경은 이 기기에 자동으로 저장되고, 홈의 ‘내 미로’에서 다시 열 수 있습니다.</p>
      </section>
      <section>
        <h3>물의 정원</h3>
        <p>아래 수로 컬렉션에서 정원을 고르고 <strong>물 흘려보내기</strong>를 누르세요. 3D와 2D를 바꿔 보고, 물색·재질·빛을 튜닝할 수 있습니다. 저장한 미로는 프로젝트 카드의 <strong>물로 보기</strong>로 엽니다.</p>
      </section>
      <section>
        <h3>물길 크래프트와 챌린지</h3>
        <p>장치를 추가해 수원 탑에서 종착 연못까지 물길을 잇습니다. 물길이 막히면 이유와 <strong>추천 해결 방법</strong>이 나타나고, 누르면 바로 적용됩니다. 프리셋을 불러오거나 모두 비운 직후에는 <strong>되돌리기</strong>로 이전 물길을 되찾을 수 있습니다.</p>
        <p><strong>챌린지</strong>는 4장 20단계입니다. 단계마다 새 장치나 요령을 하나씩 배우고, 실제 물 시뮬레이션이 목표를 달성하면 별을 줍니다. 목표를 채우면 별 하나, 정해진 시간 안에 도착하면 하나, 적은 장치로 만들면 하나를 더 받습니다. 별을 하나 이상 얻으면 다음 단계가 열립니다.</p>
        <p>막히면 <strong>힌트 보기</strong>를 두 번까지 누를 수 있고, 그래도 어려우면 <strong>정답 보기</strong>로 정답 물길을 적용합니다. 정답을 본 도전은 별 1개만 받습니다.</p>
      </section>
      <section>
        <h3>조작</h3>
        <table className="info-controls">
          <thead><tr><th scope="col">동작</th><th scope="col">마우스·키보드</th><th scope="col">터치</th></tr></thead>
          <tbody>
            <tr><th scope="row">회전 (3D)</th><td>드래그</td><td>한 손가락으로 끌기</td></tr>
            <tr><th scope="row">이동</th><td>오른쪽 버튼 또는 Shift + 드래그</td><td>두 손가락으로 끌기</td></tr>
            <tr><th scope="row">확대·축소</th><td>휠, + / - 키</td><td>두 손가락 벌리기·모으기</td></tr>
            <tr><th scope="row">시점 초기화</th><td>더블클릭, Home 또는 0 키</td><td>시점 초기화 버튼</td></tr>
            <tr><th scope="row">실행 취소 (미로 제작)</th><td>Ctrl/⌘ + Z, 다시 실행은 Shift 함께</td><td>실행 취소 버튼</td></tr>
            <tr><th scope="row">패널·몰입 화면 닫기</th><td>Esc</td><td>닫기 버튼</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  )
}

function SettingsTab({ theme, onThemeChange, quality, onQualityChange }: Pick<Props, 'theme' | 'onThemeChange' | 'quality' | 'onQualityChange'>) {
  return (
    <div className="info-section">
      <section>
        <h3>화면 테마</h3>
        <Choice label="화면 테마" value={theme} onChange={onThemeChange}
          options={[['system', '기기 설정 따르기'], ['light', '밝게'], ['dark', '어둡게']]} />
        <p className="info-note">물의 정원과 크래프트 작업실은 물빛을 정확히 보이도록 항상 밝은 화면으로 표시됩니다.</p>
      </section>
      <section>
        <h3>그래픽 품질</h3>
        <Choice label="그래픽 품질" value={quality} onChange={onQualityChange}
          options={[['auto', '자동 (권장)'], ['high', '선명하게'], ['low', '가볍게']]} />
        <p className="info-note">자동은 컴퓨터에서 선명하게, 메모리가 적은 휴대폰과 태블릿에서는 가볍게 그립니다. 물의 정원이 끊기거나 기기가 뜨거워지면 ‘가볍게’를 고르세요. 바꾸면 열려 있는 장면을 새로 준비합니다.</p>
      </section>
      <section>
        <h3>소리와 카메라</h3>
        <p className="info-note">효과음과 시네마틱 카메라는 각 작업실의 재생 막대에서 켜고 끕니다. 기기에서 ‘동작 줄이기’를 켜 두면 시네마틱 카메라는 처음부터 꺼진 상태로 시작합니다.</p>
      </section>
    </div>
  )
}

function DataTab({ storageVolatile, projectCount, onRestore, onToast }: Pick<Props, 'storageVolatile' | 'projectCount' | 'onRestore' | 'onToast'>) {
  const [storage, setStorage] = useState<StorageState | null>(null)
  const [busy, setBusy] = useState<'backup' | 'restore' | 'persist' | null>(null)
  const restoreInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let active = true
    void readStorageState().then((state) => { if (active) setStorage(state) })
    return () => { active = false }
  }, [])

  const backup = async () => {
    setBusy('backup')
    try {
      const { blob, projectCount: count } = await createBackup(localProjectRepository)
      downloadBlob(blob, backupFileName())
      onToast(`프로젝트 ${count}개와 게임 기록을 백업 파일로 저장했습니다.`)
    } catch {
      onToast('백업 파일을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.', true)
    } finally {
      setBusy(null)
    }
  }

  const restore = async (file?: File) => {
    if (!file) return
    setBusy('restore')
    try {
      await onRestore(file)
      setStorage(await readStorageState())
    } finally {
      setBusy(null)
    }
  }

  const persist = async () => {
    setBusy('persist')
    const granted = await requestPersistentStorage()
    setStorage(await readStorageState())
    setBusy(null)
    onToast(granted ? '브라우저가 이 기기의 작업을 지우지 않도록 보호합니다.' : '브라우저가 보호 요청을 받아들이지 않았습니다. 중요한 작업은 백업해 두세요.', !granted)
  }

  return (
    <div className="info-section">
      <section>
        <h3>이 기기의 저장 상태</h3>
        {storageVolatile ? (
          <p className="info-alert"><TriangleAlert size={16} aria-hidden="true" />이 브라우저는 작업을 기기에 저장하지 못합니다. 탭을 닫으면 사라지므로 지금 백업해 두세요.</p>
        ) : (
          <ul className="info-facts">
            <li>저장된 프로젝트 <strong>{projectCount}개</strong>{storage?.usage != null && <> · 사용 중 {formatBytes(storage.usage)}{storage.quota ? ` / 가능 ${formatBytes(storage.quota)}` : ''}</>}</li>
            <li>
              {storage?.persisted
                ? <><ShieldCheck size={15} aria-hidden="true" /> 브라우저가 이 사이트의 저장 데이터를 지우지 않도록 보호 중입니다.</>
                : '공간이 부족하면 브라우저가 오래 쓰지 않은 사이트의 데이터를 지울 수 있습니다.'}
            </li>
          </ul>
        )}
        {!storageVolatile && storage?.persisted === false && (
          <button className="button secondary small" type="button" disabled={busy !== null} onClick={() => void persist()}>
            <ShieldCheck size={15} />삭제 방지 요청
          </button>
        )}
      </section>
      <section>
        <h3>백업과 복원</h3>
        <p className="info-note">백업 파일 하나에 모든 프로젝트(이미지 포함), 챌린지 별, 크래프트 물길과 설정이 들어갑니다. 다른 브라우저나 기기에서 복원할 수 있고, 이 기기의 더 최신 작업은 덮어쓰지 않습니다.</p>
        <div className="info-actions">
          <button className="button" type="button" disabled={busy !== null} onClick={() => void backup()}>
            <HardDriveDownload size={16} />{busy === 'backup' ? '백업 중…' : '전체 백업 받기'}
          </button>
          <button className="button secondary" type="button" disabled={busy !== null} onClick={() => restoreInput.current?.click()}>
            <HardDriveUpload size={16} />{busy === 'restore' ? '복원 중…' : '백업 파일로 복원'}
          </button>
          <input ref={restoreInput} className="sr-only" type="file" accept=".json,application/json" tabIndex={-1} aria-label="백업 파일 선택"
            onChange={(event) => { void restore(event.target.files?.[0]); event.currentTarget.value = '' }} />
        </div>
      </section>
      <section>
        <h3>개인정보</h3>
        <ul className="info-list">
          <li>회원가입이 없고, 만든 작업은 이 브라우저 안에만 저장됩니다. 앱은 작업 내용을 외부 서버로 보내지 않으며 광고·분석 도구를 쓰지 않습니다.</li>
          <li>페이지를 불러올 때 호스팅 서비스에 일반적인 접속 기록(IP 주소, 브라우저 종류)이 남을 수 있습니다.</li>
          <li>공유 링크와 QR에는 미로 전체가 주소 안에 담깁니다. 시크릿 메시지와 이미지도 포함되므로 링크를 가진 사람은 누구나 볼 수 있습니다.</li>
          <li>브라우저 데이터를 지우거나 사생활 보호 창을 닫으면 작업과 기록이 삭제됩니다.</li>
        </ul>
      </section>
    </div>
  )
}

function AboutTab() {
  return (
    <div className="info-section">
      <section>
        <h3>MazeCraft · 메이즈크래프트</h3>
        <p>미로를 설계하고 그 길 위로 물을 흘려보내는 미로와 물의 아틀리에입니다.</p>
        <ul className="info-facts">
          <li>버전 <strong>{versionLabel()}</strong></li>
          <li>최신 Chrome·Edge·Firefox, Safari 16.4 이상, WebGL 2를 지원하는 브라우저에서 동작합니다.</li>
        </ul>
      </section>
      <section>
        <h3>오픈소스</h3>
        <table className="info-credits">
          <tbody>
            {CREDITS.map(([name, license]) => <tr key={name}><th scope="row">{name}</th><td>{license}</td></tr>)}
          </tbody>
        </table>
        <a className="info-link" href="./licenses.txt" target="_blank" rel="noopener">
          <ExternalLink size={14} aria-hidden="true" />라이선스 전문 보기
        </a>
      </section>
    </div>
  )
}

/** Help, settings, data safety and app information in one place. */
export default function InfoDialog({ initialTab = 'help', onClose, ...props }: Props) {
  const [tab, setTab] = useState<InfoTab>(initialTab)
  useEffect(() => setTab(initialTab), [initialTab])
  return (
    <Dialog title="도움말과 설정" onClose={onClose} labelledBy="info-dialog-title">
      <div className="info-dialog">
        <div className="info-tabs" role="tablist" aria-label="도움말 항목">
          {TABS.map(([id, label]) => (
            <button key={id} id={`info-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls="info-panel"
              tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}
              onKeyDown={(event) => {
                const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                if (!offset) return
                event.preventDefault()
                const next = TABS[(TABS.findIndex(([item]) => item === tab) + offset + TABS.length) % TABS.length][0]
                setTab(next)
                document.getElementById(`info-tab-${next}`)?.focus()
              }}>
              {label}
            </button>
          ))}
        </div>
        <div id="info-panel" role="tabpanel" aria-labelledby={`info-tab-${tab}`}>
          {tab === 'help' && <HelpTab />}
          {tab === 'settings' && <SettingsTab {...props} />}
          {tab === 'data' && <DataTab {...props} />}
          {tab === 'about' && <AboutTab />}
        </div>
      </div>
    </Dialog>
  )
}
