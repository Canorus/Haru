# Siri 단축어 연동

Haru 설정의 **단축어 · MCP · CLI**에서 외부 도구 토큰 사용을 켠 뒤 단축어마다 전용 토큰을 발급합니다. 등록 단축어에는 `할 일 등록(write)`, 조회 단축어에는 `전체 데이터 조회(read)` 권한을 사용합니다. 원문은 발급 직후 한 번만 표시되고 서버에는 SHA-256 해시만 저장됩니다.

두 API는 브라우저 세션 쿠키 대신 다음 헤더를 요구합니다.

```http
Authorization: Bearer haru_sc_...
X-Haru-Username: username
Content-Type: application/json
```

`X-Haru-Username`은 토큰이 다른 계정으로 잘못 전달되는 것을 막는 추가 확인값입니다.

## 할 일 등록 및 수정

```http
POST /api/shortcuts/tasks

{"title":"우유 사기","list":"장보기","due":"2026-12-25","priority":"high"}
```

`X-Haru-Task-Id` 헤더가 없거나 비어 있거나 `null`이면 새 할 일을 등록하며 이때 `title`은 필수입니다. 조회 API에서 받은 태스크 ID를 헤더에 넣으면 해당 태스크를 수정합니다. 수정 요청의 JSON에는 변경할 필드만 보내면 됩니다.

```http
X-Haru-Task-Id: task_...

{"title":"저지방 우유 사기","completed":false}
```

`list`는 접근 가능한 리스트 이름, `due`는 ISO 날짜/시각 또는 `null`, `priority`는 `none`, `low`, `medium`, `high` 중 하나입니다. 제목 안의 Haru 마커와 자연어 날짜는 신규 등록에서 웹 입력과 같은 방식으로 처리합니다. 신규 등록은 HTTP `201`, 수정은 `200`을 반환합니다.

단축어 앱에서는 텍스트 동작에 호스트, 사용자명, write 토큰과 선택적인 태스크 ID를 두고, **URL 콘텐츠 가져오기**를 POST/JSON으로 설정합니다. URL은 `[호스트]/api/shortcuts/tasks`입니다. 새 할 일은 `X-Haru-Task-Id`를 보내지 않고, 수정할 때만 ID를 헤더에 넣는 구성이 가장 안전합니다.

## 전체 데이터 조회

```http
GET /api/shortcuts/snapshot
```

응답 payload에는 사용자 정보, 접근 가능한 모든 리스트와 태스크, 안전하게 마스킹된 설정, 알림 개수 및 생성 시각이 들어갑니다. 비밀번호, CalDAV 암호, 세션, 토큰 원문은 포함되지 않습니다.

조회 단축어에서는 read 토큰으로 **URL 콘텐츠 가져오기**를 실행하고 결과를 **빠른 보기** 또는 다음 AI 동작의 입력으로 전달합니다. URL은 `[호스트]/api/shortcuts/snapshot`입니다.

## 운영 원칙

- 한 단축어에 한 토큰을 발급해 권한과 폐기 범위를 분리합니다.
- 토큰이 노출되면 설정 화면에서 해당 항목만 즉시 폐기합니다.
- 외부 도구 토큰 사용을 끄면 그 계정의 모든 단축어 토큰이 즉시 폐기됩니다.
- URL 쿼리 문자열에는 토큰을 넣지 않습니다. 브라우저 기록, 프록시 로그, 분석 도구에 남을 수 있기 때문입니다.
- Siri에서는 단축어 이름을 말해 실행합니다. 최초 실행 시 네트워크 접근 권한을 승인해야 할 수 있습니다.
