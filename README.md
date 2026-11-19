# Haru Todo — 테스트 페이지

도메인 종속 계정, 리스트/태스크, 목록 단위 협업, 반복 일정, 알림, PWA 셸, CLI와 CalDAV `VTODO` 출력을 포함한 무의존성 Node.js 프로토타입입니다.

프로덕션 설치, Nginx 서브디렉터리 구성, Radicale 연결, CLI와 PWA 설치 절차는
[`docs/INSTALL.md`](docs/INSTALL.md)를 참고하세요.

Siri 단축어용 읽기/등록 토큰과 API 구성은 [`docs/SHORTCUTS.md`](docs/SHORTCUTS.md)를 참고하세요.

## 실행

Node.js 20 이상에서:

```bash
npm start
```

브라우저에서 `http://127.0.0.1:3000`을 엽니다. 새 로컬 데이터 저장소의 관리자명은
`admin`입니다. `HARU_INITIAL_ADMIN_PASSWORD`를 지정하지 않으면 최초 실행 로그에
무작위 비밀번호가 한 번만 표시되며, 로그인 직후 변경해야 합니다. `data/store.json`에는
비밀번호가 Node의 `scrypt` 해시로만 저장됩니다.

### 서브디렉터리에서 실행

다른 서비스와 같은 도메인을 공유할 때 `BASE_PATH`를 지정할 수 있습니다.

```bash
BASE_PATH=/haru PORT=3000 npm start
```

이 경우 웹, API, PWA service worker, manifest, 쿠키 및 CalDAV URL은 모두 `https://example.com/haru/` 아래에 한정됩니다. CLI에는 전체 경로를 지정합니다.

```bash
HARU_URL=https://example.com/haru python3 cli/todo.py list
```

Nginx는 경로를 제거하지 않고 그대로 Node.js에 전달해야 합니다.

```nginx
location = /haru { return 308 /haru/; }
location /haru/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

# 선택 사항: 루트 도메인에 다른 CalDAV 서비스가 없을 때만 사용합니다.
location = /.well-known/caldav {
    return 301 /haru/caldav/;
}
```

`proxy_pass` 주소 뒤에 `/`를 붙이면 `/haru`가 제거될 수 있으므로 위 설정에서는 붙이지 않습니다.
Super Productivity처럼 CalDAV URL을 직접 지정할 수 있는 클라이언트에는
`https://example.com/haru/caldav/`를 입력하면 되며 `.well-known` 설정은 필요하지 않습니다.

### 선택적 CalDAV 연결(Radicale 예시)

Haru는 CalDAV 없이 독립 실행됩니다. 필요하다면 Radicale을 포함한 표준 CalDAV
서버를 canonical 저장소로 연결하고 Haru 경로 아래로 노출할 수 있습니다.

```bash
CALDAV_UPSTREAM=http://127.0.0.1:5232 BASE_PATH=/haru npm start
```

`/haru/caldav/` 아래의 요청은 인증 헤더를 포함해 Radicale로 전달됩니다. XML의
DAV href와 Destination 경로는 서브디렉터리에 맞게 양방향 변환되므로 Radicale이
지원하는 PROPFIND, REPORT, PUT, DELETE 및 sync-token을 그대로 사용할 수 있습니다.
외부 CalDAV 클라이언트는 자신의 인증 정보를 직접 사용합니다. Haru 내부 동기화는
설정 화면에 입력한 ID와 비밀번호를 HTTPS Basic 인증 헤더로 보내며, 비밀번호는
`HARU_CREDENTIAL_KEY`로 AES-256-GCM 암호화해 서버에 저장하고 API 응답에는 포함하지 않습니다.

## 사용법

- 입력란에 `운동하기 ~개인`처럼 쓰면 해당 리스트에 바로 들어갑니다.
- 자신이 소유한 리스트의 태스크에 `@사용자명`을 붙이면 같은 인스턴스 사용자에게 목록 협업 요청을 보냅니다. `@사용자명@인스턴스` 표기도 인식합니다.
- 상대방은 오른쪽 위 알림에서 요청을 승인하거나 거절합니다. 승인 후 공유 리스트가 상대방 사이드바에 나타나며 양쪽에서 태스크를 추가·완료·삭제할 수 있습니다.
- 계정 화면의 **협업 권한**에서 승인된 공유를 확인하고 제거할 수 있습니다.
- 반복은 없음, 매시간, 매일, 매주 특정 요일, 매월 특정 일, 매년 특정 날짜를 지원합니다. 반복 태스크를 완료하면 다음 회차가 자동 생성됩니다.
- 알림에는 승인 대기 협업 요청과 기한이 지났거나 3일 이내로 다가온 접근 가능한 태스크가 표시됩니다.
- 존재하지 않는 리스트를 설정된 리스트 마커와 함께 쓰면 생성 확인창이 열립니다(기본값: `*리스트명`).
- `월요일까지` 같은 한글 요일은 가장 가까운 해당 요일의 기한으로 처리합니다. `다음 일요일`, `다다음 일요일`은 각각 가장 가까운 일요일에서 1주·2주 뒤를, `마지막 일요일`은 이번 달 마지막 일요일을 지정합니다.
- 명시하지 않으면 설정의 기본 리스트(초기값 `수집`)를 사용합니다.
- 태스크 체크, 삭제, 리스트 추가, 기한·우선도 및 설정 저장이 실제 API와 로컬 데이터에 반영됩니다.
- 태스크 항목을 클릭하거나 터치하면 제목, 메모, 리스트, 기한, 우선도, 태그와 반복 설정을 편집할 수 있습니다.
- 설정 화면에서 현재 기기의 리스트와 태스크를 기기 시간 metadata가 포함된 JSON으로 내보내고, 기존 데이터를 유지한 채 다시 가져올 수 있습니다.
- PWA 설치 이벤트와 오프라인 정적 셸·데이터 캐시가 포함되어 있습니다. 한 번 로그인해 데이터를 받은 기기에서는 네트워크 없이 태스크와 리스트를 편집할 수 있고, 연결이 돌아오면 서버와 자동 동기화합니다. 실제 설치는 HTTPS 또는 localhost 계열 주소가 필요합니다.
- 제목, 메모, 리스트 이름은 UTF-8 이모지를 지원하며 저장 전 NFC로 정규화됩니다. 운영 PostgreSQL 스키마도 UTF-8을 강제합니다.

## CLI

태스크 제목에는 기본 설정 기준으로 `*리스트`, `!3`(높음)·`!2`(보통)·`!1`(낮음), `#태그`를 함께 쓸 수 있습니다. `*(장기 프로젝트)`와 `#(집중 작업)`처럼 괄호를 쓰면 공백이 포함된 이름도 인식합니다. 세 마커는 설정 화면에서 `~!#$%^&*` 중 서로 다른 문자로 바꿀 수 있습니다. `@`는 협업 요청 전용 마커입니다. `내일`, `모레`, `글피`, `on Tuesday`, `by Thu` 같은 표현은 기한으로 변환되며, 단독 요일처럼 애매한 표현은 등록 전에 확인합니다.

서버가 실행 중일 때:

```bash
python3 cli/todo.py add "제안서 검토" --list 업무 --due tomorrow --priority high
python3 cli/todo.py add "매일 백업 확인" -l 업무 -d tomorrow --repeat daily
python3 cli/todo.py add "주간 회의 @teammate" -l 업무 --repeat weekly:1
python3 cli/todo.py list -l 업무 -d tomorrow -p high
python3 cli/todo.py done task_UUID
python3 cli/todo.py create newuser --role user
```

패키지를 실행 경로에 설치하면 `haru create username --role user` 형식으로 사용할 수
있습니다. 비밀번호를 생략하면 임시 비밀번호를 자동 생성해 한 번 표시하며, 새 계정은
첫 로그인 후 비밀번호를 변경해야 합니다. 이전 호환성을 위해 비밀번호 위치 인자도
지원합니다. 사용자 생성에는 관리자 인증이 필요하고 새 사용자는 독립된 `수집`
리스트와 기본 설정을 받습니다.

CLI는 로컬 주소 `http://127.0.0.1:3000/haru`를 기본값으로 사용합니다. 다른
인스턴스의 접속 정보는 `HARU_URL`, `HARU_USERNAME`, `HARU_PASSWORD` 환경 변수로
바꿀 수 있습니다. `HARU_PASSWORD`를 생략하면 CLI가 관리자 비밀번호를 대화형으로
요청합니다.

## Siri 단축어 토큰

설정 화면에서 외부 도구 토큰 사용을 켜면 `read` 또는 `write` 전용 토큰을 발급하고 개별 폐기할 수 있습니다. 토큰 원문은 한 번만 표시되며 서버에는 SHA-256 해시만 저장됩니다. 조회 API는 로그인 사용자가 볼 수 있는 모든 리스트와 태스크를 한 payload로 반환합니다. 쓰기 API는 `X-Haru-Task-Id` 헤더가 없거나 `null`이면 태스크를 만들고, 조회 결과의 태스크 ID를 헤더로 보내면 해당 태스크를 수정합니다. 토큰은 URL이 아니라 `Authorization: Bearer` 헤더로 전달합니다.

## 계정 권한

- `admin`: 계정 생성, `admin/user/guest` 권한 부여, 일반 계정 삭제를 포함한 전체 기능
- `user`: 자신의 태스크·리스트·설정과 승인된 공유 리스트를 읽고 변경
- `guest`: 자신의 데이터와 승인된 공유 리스트 읽기 전용

admin 계정은 다른 계정이 삭제하거나 강등할 수 없습니다. 본인이 계정 화면의 권한
포기 절차를 실행해야 하며 마지막 admin은 권한을 포기할 수 없습니다.

## 협업 범위

현재 실제 요청 전달과 승인은 같은 Haru 인스턴스 안의 계정끼리 지원합니다. 로컬
계정은 `@username`, 전체 주소는 `@username@instance`로 표기합니다. 다른 도메인의
주소도 문법적으로 식별하지만, 인스턴스 간 신뢰·서명 프로토콜이 아직 없으므로 원격
전송은 명확한 오류로 거절합니다. 승인되지 않은 원격 요청을 임의로 수락하지 않습니다.
공유 권한은 리스트 단위이며 리스트 소유자와 초대받은 사용자 중 어느 쪽이든 계정
화면에서 승인을 제거할 수 있습니다.

데이터 초기화는 Haru 로컬 데이터를 먼저 삭제하고 영속 동기화 큐에 삭제 작업을
기록합니다. CalDAV 연결이 있을 때 어댑터가 이 큐를 원격 서버에 전달하며, 실패한
작업은 큐에 남아 다음 동기화에서 다시 시도됩니다.

## 오프라인 작업과 충돌 정책

브라우저 데이터는 서버 주소와 사용자 ID를 합친 키로 IndexedDB에 분리 저장됩니다.
오프라인 변경은 로컬 스냅샷과 outbox에 함께 기록되며, 재연결·화면 복귀·수동 동기화
시 서버에 전달됩니다. 서버는 삭제 작업을 먼저 적용하고 mutation ID로 재전송을
멱등 처리합니다. 모든 사용자 내용이 같은 중복 태스크는 최초 생성 항목으로 병합하며,
반복 태스크의 다음 회차도 최초 요청만 생성합니다.

서버 버전과 다른 항목을 편집한 경우에는 충돌로 판정해 로컬 변경을 버리고 마지막
서버 스냅샷으로 통일합니다. 공유 권한이 취소된 뒤 만들어진 오프라인 편집도 서버가
거부하고 클라이언트에서 폐기합니다. 실패·충돌·권한 취소는 화면 우하단에 표시됩니다.
Haru 서버와 브라우저의 동기화가 끝난 뒤에만 CalDAV 동기화를 시작합니다.

## 현재 범위와 프로덕션 전환

이 결과물은 화면과 UX를 검증하는 테스트 앱입니다. 배포 환경에서는 `/haru/caldav/`
프록시가 기존 Radicale의 `PROPFIND`, `REPORT`, `PUT`, `DELETE`, sync-token 처리를
그대로 전달하고, Haru API도 관리자 계정의 Radicale VTODO를 동기화합니다. 새로 만든
Haru 사용자는 관리자 CalDAV 데이터를 공유하지 않고 독립된 로컬 저장 공간을 사용합니다.

1. Nginx에서 TLS 종료, 정적 파일 캐시, `/api`와 `/caldav`의 Node.js 프록시를 담당합니다.
2. JSON 저장소를 PostgreSQL의 [`docs/schema.sql`](docs/schema.sql)로 교체합니다.
3. 세션 저장소를 Redis로 교체하고 secure cookie, CSRF, 로그인 rate limit을 적용합니다.
4. CalDAV discovery와 collection sync, ETag 충돌 해결을 구현합니다.
5. MCP는 해시된 API 토큰과 scope를 사용하는 별도 transport로 연결합니다.

Super Productivity의 현재 구현은 `VCALENDAR` 안의 `VTODO`를 조회하고 `UID`, `SUMMARY`, `DTSTART`, `DUE`, `CATEGORIES`를 읽으며, 완료 판정에는 `COMPLETED`, `STATUS`, `PERCENT-COMPLETE` 중 하나를 사용합니다. 스키마의 CalDAV 필드는 이 호환면을 기준으로 설계했습니다.
