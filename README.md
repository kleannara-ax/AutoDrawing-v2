# AutoDrawing Ver.2.0

AI 기반 손도면(스케치) 분석 및 기계제도 자동 생성 시스템

## 개요

손으로 그린 도면 이미지를 업로드하면 AI가 형상을 분석하여 KS/ISO 규격에 맞는 기계제도 도면을 자동으로 생성합니다.

## 주요 기능

- **손도면 이미지 분석** — OpenAI Vision API를 활용한 형상 인식
- **자동 도면 생성** — 정면도 + 보조뷰 + 치수선 자동 배치
- **숨은선 표현** — 탭구멍, 키홈, 카운터보어 등 내부 형상 표시
- **치수 공차** — ±공차 자동 표기, 70% 축소 폰트
- **대화형 편집** — SVG 기반 요소 선택, 수정, 삭제
- **내보내기** — SVG/PNG 다운로드 지원

## 기술 스택

| 구분 | 기술 |
|------|------|
| 서버 | Node.js + Express (포트 8080) |
| 프론트엔드 | Vanilla JS + SVG |
| AI 엔진 | OpenAI GPT-4o Vision API |
| 렌더링 | SVG (순수 DOM 조작) |

## 프로젝트 구조

```
AutoDrawing-v2/
├── server.js           # Express API 서버 (포트 8080)
├── index.html          # 메인 UI
├── css/
│   └── style.css       # 스타일시트
├── js/
│   ├── ai-engine.js    # AI 분석 + 도면 모델 생성 엔진
│   ├── app.js          # 앱 초기화 + 프로젝트 관리
│   ├── drawing-model.js # 도면 요소 데이터 모델
│   ├── editor.js       # 대화형 편집기 (선택, 이동, 수정)
│   ├── export.js       # SVG/PNG 내보내기
│   ├── history.js      # Undo/Redo 히스토리
│   ├── image-analyzer.js # 이미지 분석 모듈
│   └── renderer.js     # SVG 렌더링 엔진
├── data/
│   └── projects.json   # 저장된 프로젝트 데이터
└── package.json
```

## 실행 방법

```bash
npm install
npm start
# → http://localhost:8080
```

## 변경 이력

### v2.0.0 (2026-04-23)
- 독립 레포지토리로 분리 (WMS 시스템과 분리)
- 탭구멍 드릴 표현 추가 (피치 테이블, 드릴삼각형)
- 숨은선 스타일 70% 축소 (dash 3 1.5, stroke 0.49)
- 치수 히트영역 3단 우선순위 분리
- 공차 렌더링 개선 (중앙 정렬, 70% 폰트)
- 수직 치수 텍스트 우측 배치
