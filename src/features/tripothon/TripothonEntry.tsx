import { ArrowRight, Droplets, Gamepad2, Hammer, RotateCcw } from 'lucide-react'
import { BrandMark } from '../../components/BrandMark'
import { CRAFT_KEY, CHALLENGE_KEY } from '../craft/craftStorage'
import './tripothon.css'

interface Props { onStart(mode: 'free' | 'challenge'): void; onHome(): void }

/** An explicit exhibition doorway; existing project and game saves stay separate. */
export default function TripothonEntry({ onStart, onHome }: Props) {
  const startFresh = () => {
    try {
      localStorage.removeItem(`${CRAFT_KEY}.tripothon`)
      localStorage.removeItem(`${CHALLENGE_KEY}.tripothon`)
    } catch { /* The demo is playable without persistence. */ }
    onStart('challenge')
  }
  return <main className="tripothon-entry" data-testid="tripothon-entry">
    <header><button className="tripothon-brand" onClick={onHome} aria-label="메이즈크래프트 홈"><BrandMark size={28} /><strong>MAZECRAFT</strong></button><span>TRIPOTHON S1 · SEOUL</span></header>
    <div className="tripothon-layout">
      <section className="tripothon-copy">
        <span className="tripothon-eyebrow">A GIFT FOR MY CHILDHOOD SELF</span>
        <h1>작은 물길로 만드는<br />나만의 세계.</h1>
        <p className="tripothon-lead">모래와 물로 놀던 어린 시절의 나에게.<br />장치를 이어 붙이고, 물을 흘려보내고,<br />내가 만든 세계가 움직이는 순간을 선물합니다.</p>
        <div className="tripothon-actions">
          <button className="tripothon-primary" onClick={() => onStart('challenge')}><Gamepad2 size={19} /><span>챌린지 플레이<small>10단계 · 목표를 보고 직접 만들기</small></span><ArrowRight size={18} /></button>
          <button onClick={() => onStart('free')}><Hammer size={19} /><span>자유롭게 세계 만들기<small>11개 프리셋 · 물길과 떠다니는 장난감</small></span><ArrowRight size={18} /></button>
        </div>
        <button className="tripothon-reset" onClick={startFresh}><RotateCcw size={14} />시연을 1단계부터 시작</button>
        <p className="tripothon-note">체험 기록은 이 기기에 저장됩니다. 시연 초기화는 출품 데모의 기록에만 적용됩니다.</p>
      </section>
      <section className="tripothon-visual" aria-label="물길 정원 실행 화면">
        <img src="./tripothon/key-visual.jpg" alt="실제 MazeCraft에서 실행 중인 도자기 물길과 정원" />
        <div className="tripothon-visual-caption"><Droplets size={18} /><span>BUILD. POUR. DISCOVER.<small>실제 게임 실행 화면</small></span></div>
      </section>
    </div>
    <ol className="tripothon-guide" aria-label="플레이 방법">
      <li><b>01</b><span><strong>장치를 고르세요</strong>오른쪽 목록에서 연못·수로·양수 장치를 추가합니다.</span></li>
      <li><b>02</b><span><strong>물을 흘려보내세요</strong>재생을 누르고, 물에 띄우기에서 장난감을 골라 보세요.</span></li>
      <li><b>03</b><span><strong>세계 안을 둘러보세요</strong>드래그로 회전, 휠로 확대. 모바일은 두 손가락으로 확대합니다.</span></li>
    </ol>
    <footer><span>Game Direction Track · Browser demo · Three.js + Rapier</span><span>회원가입 없이 체험</span></footer>
  </main>
}
