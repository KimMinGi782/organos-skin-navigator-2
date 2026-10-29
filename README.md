# OrganOS Skin Navigator 2.0

YouCam Skin Analysis v2.1 연동 재구축본. 기존 `organoslab` 운영 사이트와 독립된 새 프로젝트입니다.

## 상태 (검증 / 미검증)

검증됨
- `npm test`: 외부 API 없이 18개 테스트 통과 (Node 22)
- `lib/*.ts` 타입체크 통과 (`@types/node` 부재로 `process` 1건만 환경 문제)

미검증
- `app/` (route.ts, page.tsx)는 이 환경에서 `next build`를 돌리지 못했음 → 로컬/Vercel에서 첫 빌드 확인 필요
- 실제 YouCam 응답 스키마, 파일 등록 경로, 호스트 (아래 환경변수로 교체 가능)
- 유료 분석 성공 여부

## 환경변수

| 이름 | 필수 | 설명 |
|---|---|---|
| `YOUCAM_API_KEY` | 예 | 서버 전용 |
| `ORGANOS_ALLOW_PAID` | 아니오 | `1`일 때만 유료 호출 허용 (기본: 드라이런) |
| `YOUCAM_BASE_URL` | 아니오 | 기본 `https://yce-api-01.makeupar.com` (SKIN_AI는 `...perfectcorp.com` 사용) |
| `YOUCAM_FILE_ENDPOINT` | 아니오 | 기본 `/s2s/v2.1/file/skin-analysis` (공식 skills는 `/s2s/v2.0/file`) |

## 순서

1. `npm install && npm test && npm run build`
2. 앱에서 "잔액 확인(무료)" → 키/호스트 확인 (`GET /api/skin-analysis?check=credit`)
3. 드라이런으로 이미지 검사 (유료 호출 없음)
4. 승인 후 `ORGANOS_ALLOW_PAID=1` 설정, 유료 1회 실행
