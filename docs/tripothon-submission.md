# MazeCraft — Tripothon S1 Seoul submission

**Game Direction. No Tool Track. Theme: A Gift for My Childhood Self.**

MazeCraft is a browser game in which players connect ceramic basins, waterfalls and water machines, pour water through their design, and complete ten challenges whose goals are judged by the running simulation. Free building offers eleven complete presets, editable device sequences, orbit/zoom controls and floating toys driven by Rapier rigid-body physics.

The gift is the freedom to experiment: a miniature world for the childhood self who enjoyed building streams in sand and watching a creation come alive. The work emphasizes a playable make → pour → observe → revise loop.

## Judge entry

- Play: https://mazecraft.vercel.app/#/tripothon
- Submission media: https://mazecraft.vercel.app/tripothon/
- Reset only the exhibition save with **시연을 1단계부터 시작**.
- Add **연꽃 연못 추가**, select 4×, then press **물 흘려보내기**. Actual water reaching the terminal pond opens the stage-clear dialog and records stars.
- Return home and resume **챌린지 플레이** to reach the next unfinished unlocked stage.
- **자유롭게 세계 만들기** opens the smaller Terraced Garden preset, ready for interaction.

## This release

A dedicated exhibition doorway communicates the gift theme and offers challenge/free entry. Its localStorage keys are separate from ordinary game saves. Resetting an exhibition does not erase regular progress. The challenge picker now resumes the earliest unlocked unfinished stage. Malformed or unavailable browser storage recovers gracefully instead of crashing the course compiler.

The project is based on an existing repository first developed in July 2026. The entry includes September 2026 gameplay updates and this exhibition preparation. It is not presented as entirely new work started during the event. AI coding assistance supported development. Geometry and floating toys are created procedurally by the application; the board and walkthrough show actual runtime output. This entry makes no claim of using a sponsor tool.

## Validation

- Full unit suite: 57 files, 394 tests passed with two workers.
- TypeScript check and production build passed.
- Exhibition browser scenario passed: stage 1 actual clear, Rapier duck interaction, stage 2 resume, exhibition reset and normal-save preservation.
- Static local launchers and production deployment are checked in the handoff report.

The browser uses a conserved basin-water model and Rapier rigid bodies for floating toys. This is an interactive game simulation, not an engineering-grade fluid solver. Progress is stored per browser; private mode or browser data clearing removes it.

## Submission facts

Official rules: https://developers.tripo3d.ai/ko/events/tripothon-s1

Required: playable demo, unedited screen walkthrough, visual asset board. Public build log is optional. Direction has no prescribed stack; Tool Tracks require actual designated-tool use.

Deadline: Oct 5, 2026 AoE (UTC−12), equivalent to Oct 6, 2026 20:59:59 KST when interpreted as end of day. Seoul Demo Day is a separate application: Oct 16, 11:00–20:00 KST, https://luma.com/0qt33oqm . Account authentication, final terms and the final submission remain with the entrant.
