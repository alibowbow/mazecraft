import {
  ArrowRight,
  Clock3,
  Droplets,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  MessageSquareText,
  MoreHorizontal,
  Moon,
  Plus,
  Printer,
  Shapes,
  Sparkles,
  Sun,
  Trash2,
  Type,
} from 'lucide-react'
import { useRef } from 'react'
import type { MazeProject } from '../../core/maze/types'

export type ProjectTemplate = 'basic' | 'text' | 'image' | 'secret' | 'time-attack' | 'worksheet'

const templates: Array<{
  id: ProjectTemplate
  title: string
  description: string
  icon: typeof Shapes
  color: string
  label: string
}> = [
  { id: 'basic', title: '기본 미로', description: '형태와 난이도를 고르고 가장 빠르게 시작', icon: Shapes, color: 'mint', label: 'QUICK START' },
  { id: 'text', title: '글자 미로', description: '단어나 문장을 미로의 윤곽으로', icon: Type, color: 'blue', label: 'TYPOGRAPHY' },
  { id: 'image', title: '이미지 실루엣', description: '내 이미지 안에서 길을 만들기', icon: ImageIcon, color: 'violet', label: 'SILHOUETTE' },
  { id: 'secret', title: '시크릿 메시지', description: '완주해야 열리는 편지와 쿠폰', icon: MessageSquareText, color: 'coral', label: 'REVEAL' },
  { id: 'time-attack', title: '타임어택 챌린지', description: '제작자 기록과 벌이는 한판', icon: Clock3, color: 'amber', label: 'CHALLENGE' },
  { id: 'worksheet', title: '인쇄용 워크시트', description: 'A4 문제지와 정답지를 한 번에', icon: Printer, color: 'slate', label: 'PRINT' },
]

function HeroMazePreview() {
  return (
    <div className="hero-maze-card" aria-hidden="true">
      <div className="hero-maze-toolbar">
        <span><i /> LIVE MAZE</span>
        <strong>12 × 12</strong>
      </div>
      <div className="hero-maze-stage">
        <svg viewBox="0 0 520 360" fill="none">
          <defs>
            <linearGradient id="hero-water" x1="82" y1="48" x2="436" y2="322" gradientUnits="userSpaceOnUse">
              <stop stopColor="#7CE9FF" />
              <stop offset="1" stopColor="#1689C9" />
            </linearGradient>
            <filter id="hero-shadow" x="-20%" y="-20%" width="140%" height="160%">
              <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#1F2E31" floodOpacity=".18" />
            </filter>
          </defs>
          <rect x="34" y="28" width="452" height="304" rx="22" fill="#FFFDF7" filter="url(#hero-shadow)" />
          <path className="hero-maze-walls" d="M84 28v44h74v62H84v64h74v68h84v66M242 28v44h88v62h80V72h76M34 134h50M158 134h84v64h88v68h80v66M34 266h50v66M330 134v64h80M242 266h88" />
          <path className="hero-maze-water" d="M84 28v24h70v48h-42v64h80v56h64v52h-14v60" />
          <circle cx="84" cy="31" r="13" fill="#171B19" />
          <text x="84" y="35" textAnchor="middle" fill="white" fontSize="11" fontWeight="800">S</text>
          <circle cx="242" cy="329" r="13" fill="#FF6D43" />
          <text x="242" y="333" textAnchor="middle" fill="white" fontSize="11" fontWeight="800">E</text>
        </svg>
        <span className="hero-water-chip"><Droplets size={13} /> 중력 물 시뮬레이션</span>
      </div>
      <div className="hero-maze-footer">
        <span>검증 통과</span>
        <span>최단 경로 42칸</span>
        <strong>READY</strong>
      </div>
    </div>
  )
}

const relativeTime = (value: string) => {
  const milliseconds = Date.now() - Date.parse(value)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '방금 전'
  const minutes = Math.floor(milliseconds / 60_000)
  if (minutes < 1) return '방금 전'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.floor(hours / 24)}일 전`
}

const ProjectMiniature = ({ project }: { project: MazeProject }) => {
  const graph = project.mazeGraph
  const width = 180
  const height = 110
  const cellWidth = width / Math.max(1, graph.cols)
  const cellHeight = height / Math.max(1, graph.rows)
  const paths: string[] = []
  graph.cells.forEach((cell) => {
    if (!cell.active) return
    const x = cell.col * cellWidth
    const y = cell.row * cellHeight
    if (cell.walls.top) paths.push(`M${x} ${y}h${cellWidth}`)
    if (cell.walls.left) paths.push(`M${x} ${y}v${cellHeight}`)
    if (cell.row === graph.rows - 1 && cell.walls.bottom) paths.push(`M${x} ${y + cellHeight}h${cellWidth}`)
    if (cell.col === graph.cols - 1 && cell.walls.right) paths.push(`M${x + cellWidth} ${y}v${cellHeight}`)
  })
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${project.title} 미리보기`}>
      <rect width={width} height={height} rx="8" fill={project.background.kind === 'solid' ? project.background.color : '#f5f5ef'} />
      <path d={paths.join('')} fill="none" stroke={project.visualTheme.wallColor} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      <circle cx={(project.startCell.col + 0.5) * cellWidth} cy={(project.startCell.row + 0.5) * cellHeight} r="3" fill={project.visualTheme.startColor} />
      <circle cx={(project.endCell.col + 0.5) * cellWidth} cy={(project.endCell.row + 0.5) * cellHeight} r="3" fill={project.visualTheme.endColor} />
    </svg>
  )
}

interface HomeScreenProps {
  projects: MazeProject[]
  onCreate: (template: ProjectTemplate) => void
  onOpen: (project: MazeProject) => void
  onDuplicate: (project: MazeProject) => void
  onDelete: (project: MazeProject) => void
  onExport: (project: MazeProject) => void
  onImport: (file: File) => void
  onThemeToggle: () => void
  dark: boolean
  loading?: boolean
}

export function HomeScreen({
  projects,
  onCreate,
  onOpen,
  onDuplicate,
  onDelete,
  onExport,
  onImport,
  onThemeToggle,
  dark,
  loading,
}: HomeScreenProps) {
  const importInputRef = useRef<HTMLInputElement>(null)

  return (
    <main className="home-shell">
      <input
        ref={importInputRef}
        className="sr-only"
        type="file"
        accept=".mazecraft,.json,application/json"
        aria-label="프로젝트 파일 선택"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onImport(file)
          event.currentTarget.value = ''
        }}
      />
      <header className="home-header">
        <a className="brand" href="#" aria-label="메이즈크래프트 홈">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span><strong>MazeCraft</strong><small>메이즈크래프트</small></span>
        </a>
        <div className="home-header-actions">
          <span className="local-badge"><i /> 이 기기에 자동 저장</span>
          <button className="icon-button" aria-label={dark ? '라이트 모드' : '다크 모드'} onClick={onThemeToggle}>
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      <section className="home-hero">
        <div className="home-hero-copy">
          <p className="eyebrow"><Sparkles size={13} /> PLAY TO UNLOCK</p>
          <h1>미로를 만들고,<br /><span>이야기를 숨기세요.</span></h1>
          <p>형태를 고르고, 길을 만들고, 직접 검증하세요. 누군가의 완주 끝에 메시지와 이미지가 열립니다.</p>
          <div className="home-hero-actions">
            <button className="button hero-primary" onClick={() => onCreate('basic')}>새 미로 만들기 <ArrowRight size={17} /></button>
            <button className="button secondary file-button" onClick={() => importInputRef.current?.click()}>
              <FolderOpen size={17} /> 기존 프로젝트 열기
            </button>
          </div>
          <div className="home-capabilities" aria-label="주요 기능">
            <span>150×150 대형 미로</span>
            <span>3D 물 시뮬레이션</span>
            <span>링크·QR 공유</span>
          </div>
        </div>
        <HeroMazePreview />
      </section>

      <section className="home-section" id="templates" aria-labelledby="new-maze-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">01 · START MODE</p>
            <h2 id="new-maze-title">무엇을 만들까요?</h2>
          </div>
          <span className="section-note">템플릿은 시작점일 뿐, 편집기에서 모두 바꿀 수 있습니다</span>
        </div>
        <div className="template-grid">
          {templates.map((template, index) => {
            const Icon = template.icon
            return (
              <button
                key={template.id}
                className={`template-card tone-${template.color} ${template.id === 'basic' ? 'featured' : ''}`}
                onClick={() => onCreate(template.id)}
              >
                <span className="template-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="template-icon"><Icon size={21} /></span>
                <span className="template-copy"><em>{template.label}</em><strong>{template.title}</strong><small>{template.description}</small></span>
                <span className="template-open"><Plus size={16} /></span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="home-section projects-section" aria-labelledby="recent-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">02 · YOUR WORK</p>
            <h2 id="recent-title">최근 프로젝트 <span>{projects.length}</span></h2>
          </div>
          <button className="button secondary file-button" onClick={() => importInputRef.current?.click()}>
            <FolderOpen size={17} />
            파일 열기
          </button>
        </div>

        {loading ? (
          <div className="empty-projects" aria-live="polite">프로젝트를 불러오는 중입니다…</div>
        ) : projects.length ? (
          <div className="project-grid">
            {projects.slice(0, 12).map((project) => (
              <article className="project-card" key={project.id}>
                <button className="project-preview" onClick={() => onOpen(project)}>
                  <ProjectMiniature project={project} />
                  <span className="continue-label">계속 편집</span>
                </button>
                <div className="project-meta">
                  <button className="project-title" onClick={() => onOpen(project)}>
                    <strong>{project.title}</strong>
                    <small>{relativeTime(project.updatedAt)} · {project.grid.cols}×{project.grid.rows}</small>
                  </button>
                  <details className="project-menu">
                    <summary aria-label={`${project.title} 메뉴`}><MoreHorizontal size={20} /></summary>
                    <div className="project-menu-popover">
                      <button onClick={() => onDuplicate(project)}>복제</button>
                      <button onClick={() => onExport(project)}>내보내기</button>
                      <button className="danger" onClick={() => onDelete(project)}><Trash2 size={15} /> 삭제</button>
                    </div>
                  </details>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-projects">
            <FileText size={28} />
            <strong>아직 저장된 미로가 없습니다</strong>
            <span>위 템플릿 중 하나를 선택하면 자동 저장이 시작됩니다.</span>
          </div>
        )}
      </section>
      <footer className="home-footer">MAZECRAFT CORE 1.0 · LOCAL FIRST CREATIVE TOOL</footer>
    </main>
  )
}
