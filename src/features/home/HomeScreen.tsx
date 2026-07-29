import {
  Clock3,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  Printer,
  Shapes,
  Trash2,
  Type,
} from 'lucide-react'
import type { MazeProject } from '../../core/maze/types'

export type ProjectTemplate = 'basic' | 'text' | 'image' | 'secret' | 'time-attack' | 'worksheet'

const templates: Array<{
  id: ProjectTemplate
  title: string
  description: string
  icon: typeof Shapes
  color: string
}> = [
  { id: 'basic', title: '기본 미로', description: '도형과 난이도를 골라 바로 시작', icon: Shapes, color: 'mint' },
  { id: 'text', title: '글자 미로', description: '단어나 문장을 미로의 윤곽으로', icon: Type, color: 'blue' },
  { id: 'image', title: '이미지 실루엣', description: '내 이미지 안에서 길을 만들기', icon: ImageIcon, color: 'violet' },
  { id: 'secret', title: '시크릿 메시지', description: '완주해야 열리는 편지와 쿠폰', icon: MessageSquareText, color: 'coral' },
  { id: 'time-attack', title: '타임어택 챌린지', description: '제작자 기록과 벌이는 한판', icon: Clock3, color: 'amber' },
  { id: 'worksheet', title: '인쇄용 워크시트', description: 'A4 문제지와 정답지를 한 번에', icon: Printer, color: 'slate' },
]

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
  loading,
}: HomeScreenProps) {
  return (
    <main className="home-shell">
      <header className="home-header">
        <a className="brand" href="#" aria-label="메이즈크래프트 홈">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span><strong>MazeCraft</strong><small>메이즈크래프트</small></span>
        </a>
        <div className="home-version"><span>Core 1.0</span><span className="local-badge">이 기기에 저장</span></div>
      </header>

      <section className="home-hero">
        <p className="eyebrow">PLAY TO UNLOCK</p>
        <h1>풀어야만 열리는 이야기</h1>
        <p>미로를 만들고, 직접 검증하고, 누군가의 완주 끝에 메시지를 공개하세요.</p>
      </section>

      <section className="home-section" aria-labelledby="new-maze-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">01 · CREATE</p>
            <h2 id="new-maze-title">새 미로 만들기</h2>
          </div>
          <span className="section-note">모든 작업은 브라우저 안에서 처리됩니다</span>
        </div>
        <div className="template-grid">
          {templates.map((template) => {
            const Icon = template.icon
            return (
              <button key={template.id} className={`template-card tone-${template.color}`} onClick={() => onCreate(template.id)}>
                <span className="template-icon"><Icon size={21} /></span>
                <span className="template-copy"><strong>{template.title}</strong><small>{template.description}</small></span>
                <Plus className="template-plus" size={18} />
              </button>
            )
          })}
        </div>
      </section>

      <section className="home-section projects-section" aria-labelledby="recent-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">02 · CONTINUE</p>
            <h2 id="recent-title">최근 프로젝트</h2>
          </div>
          <label className="button secondary file-button">
            <FolderOpen size={17} />
            파일 열기
            <input
              type="file"
              accept=".mazecraft,.json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) onImport(file)
                event.currentTarget.value = ''
              }}
            />
          </label>
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
