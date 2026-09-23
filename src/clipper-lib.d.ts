/** The subset of Clipper 6 (clipper-lib) used by the water garden compiler. */
declare module 'clipper-lib' {
  namespace ClipperLib {
    interface IntPoint { X: number; Y: number }
    type Path = IntPoint[]
    type Paths = Path[]
    interface PolyNode {
      Contour(): Path
      Childs(): PolyNode[]
      IsHole(): boolean
    }
    class PolyTree implements PolyNode {
      Contour(): Path
      Childs(): PolyNode[]
      IsHole(): boolean
    }
    class Clipper {
      constructor(initOptions?: number)
      AddPath(path: Path, polyType: number, closed: boolean): boolean
      AddPaths(paths: Paths, polyType: number, closed: boolean): boolean
      Execute(clipType: number, solution: Paths | PolyTree, subjFillType?: number, clipFillType?: number): boolean
      static PointInPolygon(point: IntPoint, path: Path): number
      static Area(path: Path): number
      static Orientation(path: Path): boolean
      static CleanPolygons(paths: Paths, distance?: number): Paths
      static SimplifyPolygons(paths: Paths, fillType?: number): Paths
    }
    class ClipperOffset {
      constructor(miterLimit?: number, arcTolerance?: number)
      AddPath(path: Path, joinType: number, endType: number): void
      AddPaths(paths: Paths, joinType: number, endType: number): void
      Execute(solution: Paths | PolyTree, delta: number): void
      Clear(): void
    }
    const ClipType: { ctIntersection: 0; ctUnion: 1; ctDifference: 2; ctXor: 3 }
    const PolyType: { ptSubject: 0; ptClip: 1 }
    const PolyFillType: { pftEvenOdd: 0; pftNonZero: 1; pftPositive: 2; pftNegative: 3 }
    const JoinType: { jtSquare: 0; jtRound: 1; jtMiter: 2 }
    const EndType: { etOpenSquare: 0; etOpenRound: 1; etOpenButt: 2; etClosedLine: 3; etClosedPolygon: 4 }
  }
  export default ClipperLib
}
