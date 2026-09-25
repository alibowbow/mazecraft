import {
  ArrowDownUp,
  ArrowRight,
  Clock3,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  MessageSquareText,
  MoreHorizontal,
  Moon,
  Plus,
  Printer,
  Search,
  Shapes,
  Sun,
  Trash2,
  Type,
  Waves,
  PencilRuler,
 Blocks } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { BottomSheet } from '../../components/BottomSheet'
import { BrandMark } from '../../components/BrandMark'
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
  { id: 'basic', title: '기본 미로', description: '형태와 난이도를 고르고 가장 빠르게 시작', icon: Shapes, color: 'mint', label: '빠른 시작' },
  { id: 'text', title: '글자 미로', description: '단어나 문장을 미로의 윤곽으로', icon: Type, color: 'blue', label: '타이포그래피' },
  { id: 'image', title: '이미지 실루엣', description: '내 이미지 안에서 길을 만들기', icon: ImageIcon, color: 'violet', label: '실루엣' },
  { id: 'secret', title: '시크릿 메시지', description: '완주해야 열리는 편지와 쿠폰', icon: MessageSquareText, color: 'coral', label: '완주 보상' },
  { id: 'time-attack', title: '타임어택 챌린지', description: '제작자 기록과 벌이는 한판', icon: Clock3, color: 'amber', label: '챌린지' },
  { id: 'worksheet', title: '인쇄용 워크시트', description: 'A4 문제지와 정답지를 한 번에', icon: Printer, color: 'slate', label: '인쇄' },
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

const ProjectMiniature = memo(function ProjectMiniature({ project }: { project: MazeProject }) {
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
})

interface HomeScreenProps {
  projects: MazeProject[]
  onCreate: (template: ProjectTemplate) => void
  /** Open a saved maze in the water garden. */
  onOpen: (project: MazeProject) => void
  /** Open a saved maze in the maze studio. */
  onEdit: (project: MazeProject) => void
  /** Enter the water garden with its collection pieces. */
  onWater: () => void
  /** Open the water craft studio. */
  onCraft?: () => void
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
  onEdit,
  onWater,
  onCraft,
  onDuplicate,
  onDelete,
  onExport,
  onImport,
  onThemeToggle,
  dark,
  loading,
}: HomeScreenProps) {
  const importInputRef = useRef<HTMLInputElement>(null)
  const [actionProject, setActionProject] = useState<MazeProject | null>(null)
  const [projectQuery, setProjectQuery] = useState('')
  const [projectSort, setProjectSort] = useState<'recent' | 'title' | 'size'>('recent')
  const latestProject = projects[0] ?? null
  const visibleProjects = useMemo(() => {
    const query = projectQuery.trim().toLocaleLowerCase('ko-KR')
    const filtered = query
      ? projects.filter((project) =>
          project.title.toLocaleLowerCase('ko-KR').includes(query) ||
          project.seed.toLocaleLowerCase('ko-KR').includes(query),
        )
      : projects
    return [...filtered].sort((left, right) => {
      if (projectSort === 'title') return left.title.localeCompare(right.title, 'ko-KR')
      if (projectSort === 'size') {
        return right.grid.rows * right.grid.cols - left.grid.rows * left.grid.cols
      }
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    })
  }, [projectQuery, projectSort, projects])

  // Arriving from a studio's "내 미로" link lands on the saved projects.
  useEffect(() => {
    if (location.hash === '#/library') document.getElementById('projects')?.scrollIntoView({ block: 'start' })
  }, [])

  const runProjectAction = (
    action: (project: MazeProject) => void,
  ) => {
    if (!actionProject) return
    const project = actionProject
    setActionProject(null)
    action(project)
  }

  return (
    <main
      className="home-shell"
      inert={actionProject ? '' : undefined}
      aria-hidden={actionProject ? true : undefined}
    >
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
          <BrandMark />
          <span><strong>MAZECRAFT</strong><small>MAZE &amp; WATER ATELIER</small></span>
        </a>
        <nav className="app-nav" aria-label="주 메뉴">
          <a href="#templates">미로 제작</a>
          <button type="button" onClick={onWater}>물의 정원</button>
          {onCraft && <button type="button" onClick={onCraft}>크래프트</button>}
          <a href="#projects">내 미로</a>
        </nav>
        <div className="home-header-actions">
          <span className="local-badge"><i /> 이 기기에 자동 저장</span>
          <button className="icon-button" aria-label={dark ? '라이트 모드' : '다크 모드'} onClick={onThemeToggle}>
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      <section className="hub-hero" aria-labelledby="home-hero-title">
        <div className="hub-intro">
          <p className="hub-eyebrow">MAZECRAFT · 미로와 물의 아틀리에</p>
          <h1 id="home-hero-title">길을 설계하고,{' '}<br /><span>물을 흘려보내다</span></h1>
          <p>종이 위에 미로를 그리듯 길을 짓고, 그 길 위로 물이 흘러가는 정원을 감상하세요. 두 작업실은 하나의 미로를 공유합니다.</p>
        </div>
        <div className="hub-doors">
          <article className="hub-door door-maze">
            <figure><img src="/assets/drafting-desk-v2.webp" width="1536" height="1024" alt="제도용 종이 위에 손으로 그린 미로와 설계 도구" decoding="async" fetchPriority="high" /></figure>
            <div className="hub-door-copy">
              <span className="hub-door-kicker"><PencilRuler size={15} /> 01 · MAZE STUDIO</span>
              <h2>미로 제작</h2>
              <p>도형·글자·이미지로 윤곽을 잡고, 난이도와 길을 다듬어 나만의 미로를 만듭니다.</p>
              <div className="hub-door-actions">
                <button className="button hero-primary" onClick={() => onCreate('basic')}>새 미로 만들기 <ArrowRight size={17} /></button>
                {latestProject ? (
                  <button className="button secondary continue-project" onClick={() => onEdit(latestProject)}>최근 미로 이어서</button>
                ) : (
                  <button className="button secondary file-button" onClick={() => importInputRef.current?.click()}><FolderOpen size={17} /> 파일 열기</button>
                )}
              </div>
            </div>
          </article>
          <article className="hub-door door-water">
            <figure><img src="/assets/water-garden.jpg" width="1164" height="776" alt="도자기 미로 정원을 따라 흐르는 물과 수차" decoding="async" /></figure>
            <div className="hub-door-copy">
              <span className="hub-door-kicker"><Waves size={15} /> 02 · WATER GARDEN</span>
              <h2>물의 정원</h2>
              <p>미로를 따라 물이 흐르고, 물레방아와 시시오도시, 사이펀이 물리 법칙대로 움직입니다. 크래프트에서 장치를 이어 나만의 물길도 지어 보세요.</p>
              <div className="hub-door-actions">
                <button className="button water-primary" onClick={onWater}>물의 정원 열기 <ArrowRight size={17} /></button>
                {onCraft && <button className="button secondary" onClick={onCraft}><Blocks size={16} /> 물길 크래프트</button>}
              </div>
            </div>
          </article>
        </div>
      </section>

      <section className="home-section" id="templates" aria-labelledby="new-maze-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">01 · 시작 방식</p>
            <h2 id="new-maze-title">무엇을 만들까요?</h2>
          </div>
          <span className="section-note">어떤 방식으로 시작해도 제작실에서 모두 바꿀 수 있습니다</span>
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

      <section className="home-section projects-section" id="projects" aria-labelledby="recent-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">02 · 내 작업</p>
            <h2 id="recent-title">프로젝트 <span>{projects.length}</span></h2>
          </div>
          <div className="project-tools">
            <label className="project-search">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">프로젝트 검색</span>
              <input
                type="search"
                value={projectQuery}
                placeholder="프로젝트 검색"
                onChange={(event) => setProjectQuery(event.target.value)}
              />
            </label>
            <label className="project-sort">
              <ArrowDownUp size={15} aria-hidden="true" />
              <span className="sr-only">프로젝트 정렬</span>
              <select value={projectSort} onChange={(event) => setProjectSort(event.target.value as typeof projectSort)}>
                <option value="recent">최근 수정순</option>
                <option value="title">이름순</option>
                <option value="size">큰 미로순</option>
              </select>
            </label>
            <button className="button secondary file-button" onClick={() => importInputRef.current?.click()}>
              <FolderOpen size={17} />
              파일 열기
            </button>
          </div>
        </div>

        {loading ? (
          <div className="empty-projects" aria-live="polite">프로젝트를 불러오는 중입니다…</div>
        ) : visibleProjects.length ? (
          <div className="project-grid">
            {visibleProjects.slice(0, 12).map((project) => (
              <article className="project-card" key={project.id}>
                <button className="project-preview" aria-label={`${project.title} 편집`} onClick={() => onEdit(project)}>
                  <ProjectMiniature project={project} />
                  <span className="continue-label">미로 편집</span>
                </button>
                <button className="project-water" onClick={() => onOpen(project)} aria-label={`${project.title} 물로 보기`}><Waves size={14} /> 물로 보기</button>
                <div className="project-meta">
                  <button className="project-title" onClick={() => onEdit(project)}>
                    <strong>{project.title}</strong>
                    <small>{relativeTime(project.updatedAt)} · {project.grid.cols}×{project.grid.rows} · 최단 {project.mazeMetrics.pathLength}칸</small>
                  </button>
                  <button
                    type="button"
                    className="project-menu-trigger"
                    aria-label={`${project.title} 메뉴`}
                    aria-haspopup="dialog"
                    aria-expanded={actionProject?.id === project.id}
                    onClick={() => setActionProject(project)}
                  >
                    <MoreHorizontal size={20} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-projects">
            <FileText size={28} />
            <strong>{projectQuery ? '검색 결과가 없습니다' : '아직 저장된 미로가 없습니다'}</strong>
            <span>{projectQuery ? '다른 이름이나 Seed로 다시 찾아보세요.' : '위 템플릿 중 하나를 선택하면 자동 저장이 시작됩니다.'}</span>
          </div>
        )}
      </section>
      <footer className="home-footer"><BrandMark size={22} /> MazeCraft · 이 기기에 자동 저장 · 회원가입 없이 링크로 공유</footer>

      <BottomSheet
        open={Boolean(actionProject)}
        onClose={() => setActionProject(null)}
        title={actionProject?.title ?? '프로젝트 메뉴'}
        description={
          actionProject
            ? `${relativeTime(actionProject.updatedAt)} · ${actionProject.grid.cols}×${actionProject.grid.rows}`
            : undefined
        }
        className="project-actions-sheet"
        maxHeight="min(72dvh, 520px)"
        closeLabel="프로젝트 메뉴 닫기"
      >
        <div className="project-action-list">
          <button type="button" onClick={() => runProjectAction(onEdit)}>
            <PencilRuler size={19} />
            <span><strong>미로 편집</strong><small>제작실에서 이 미로를 다듬습니다</small></span>
          </button>
          <button type="button" onClick={() => runProjectAction(onOpen)}>
            <Waves size={19} />
            <span><strong>물 흘리기</strong><small>물의 정원에서 이 미로에 물을 흘립니다</small></span>
          </button>
          <button type="button" onClick={() => runProjectAction(onDuplicate)}>
            <Copy size={19} />
            <span><strong>복제</strong><small>원본을 보존한 새 프로젝트를 만듭니다</small></span>
          </button>
          <button type="button" onClick={() => runProjectAction(onExport)}>
            <Download size={19} />
            <span><strong>내보내기</strong><small>이미지 또는 프로젝트 파일로 저장합니다</small></span>
          </button>
          <button className="danger" type="button" onClick={() => runProjectAction(onDelete)}>
            <Trash2 size={19} />
            <span><strong>삭제</strong><small>이 기기에서 프로젝트를 삭제합니다</small></span>
          </button>
        </div>
      </BottomSheet>
    </main>
  )
}
