# Haru 설치 가이드

Haru는 독립 실행형 애플리케이션이며 CalDAV 서버는 선택 기능입니다. Radicale은
호환 가능한 서버의 한 예일 뿐 필수 패키지나 런타임 의존성이 아닙니다.

## 1. 요구 사항

- Linux 서버와 도메인
- Docker Engine 및 Docker Compose 플러그인
- Nginx
- HTTPS 인증서(Certbot 사용 가능)
- 선택 사항: 표준 CalDAV 서버(Radicale 등)
- CLI 사용 시 Python 3.10 이상

## 2. 애플리케이션 배치

```bash
sudo mkdir -p /opt/haru
sudo chown "$USER":"$USER" /opt/haru
git clone <HARU_REPOSITORY_URL> /opt/haru
cd /opt/haru
mkdir -p data
```

`/opt/haru/.env`를 만들고 권한을 제한합니다. `HARU_CREDENTIAL_KEY`는 설정 화면에
입력한 CalDAV 비밀번호를 AES-256-GCM으로 암호화하는 키이므로 32자 이상의 무작위
값을 사용하고, 설치 후 변경하거나 분실하지 않아야 합니다.

```dotenv
HARU_DATA_DIR=./data
HARU_CREDENTIAL_KEY=replace-with-at-least-32-random-characters
HARU_INITIAL_ADMIN_PASSWORD=replace-with-a-strong-initial-password
BASE_PATH=/
INSTANCE_DOMAIN=example.com
TZ=Asia/Seoul
```

```bash
chmod 600 /opt/haru/.env
docker compose up -d --build
docker compose ps
```

기본 Compose 설정은 Node.js를 `127.0.0.1:3000`에 바인딩하고 Haru를 `/haru`
서브디렉터리에서 제공합니다. 전용 도메인의 루트에서 서비스하려면 `.env`에
`BASE_PATH=/`를 지정합니다. `HARU_HOST`와 `HARU_PORT`로 바인딩 주소와 포트도 변경할
수 있습니다. `INSTANCE_DOMAIN`은 계정 주소의 도메인이므로 실제 접속 도메인으로
설정해야 합니다. 데이터는 `data/store.json`에 유지되므로 업데이트 시
`data` 디렉터리와 `.env`를 덮어쓰거나 삭제하지 않습니다.

## 3. Nginx 서브디렉터리 프록시

기존 HTTPS `server` 블록에 다음 위치를 추가합니다. `proxy_pass` 뒤에 `/`를 붙이지
않아야 `/haru` 경로가 Node.js까지 보존됩니다.

```nginx
location = /haru {
    return 308 /haru/;
}

location /haru/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location = /.well-known/caldav {
    return 301 /haru/caldav/;
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
```

라우터의 80/443 포트가 애플리케이션 서버가 아닌 별도 엣지 서버로 전달된다면,
엣지 Nginx에서 애플리케이션 서버로 다시 프록시합니다. 저장소의
`deploy/nginx-edge.example.conf`는 별도 공개 엣지에서 애플리케이션 서버로 전달하는 예시입니다.
TLS 인증서는 공개 포트를 직접 받는 엣지 서버에서 발급하고 갱신합니다.
webroot 방식으로 인증서를 발급했다면 `deploy/certbot-reload-nginx.sh`를
`/etc/letsencrypt/renewal-hooks/deploy/`에 설치해 갱신된 인증서를 Nginx가 즉시
다시 읽도록 합니다.

Haru 계정은 접속 도메인에 종속되므로 항상 최종 도메인 주소로 로그인합니다. 새
새 데이터 저장소에는 admin 계정이 만들어집니다. `HARU_INITIAL_ADMIN_PASSWORD`를
지정하지 않으면 무작위 초기 비밀번호가 서버 로그에 한 번만 표시됩니다. 최초 로그인
직후 계정 화면에서 비밀번호를 변경해야 합니다.

## 4. 선택적 CalDAV 연동(Radicale 예시)

Haru는 자체 저장소만으로 실행됩니다. 연동하려면 설정 화면에서 표준 CalDAV 서버의
HTTPS URL, ID와 비밀번호를 입력한 뒤 **동기화**를 누릅니다. 비밀번호는 URL이나
API 응답에 포함하지 않고 서버 저장소에는 암호화된 형태로만 기록합니다. 과거 버전의
`CALDAV_UPSTREAM`, `CALDAV_USERNAME`, `CALDAV_PASSWORD`, `CALDAV_APP_USER` 환경 변수도
호환 목적으로 계속 지원됩니다. Haru는 Radicale 설정 파일을 수정하지 않습니다.

```bash
curl -i -u radicale-user:password \
  -X PROPFIND -H 'Depth: 0' \
  https://example.com/haru/caldav/
```

관리자 Haru 계정의 데이터 초기화를 실행하면 연결된 Radicale의 VTODO 컬렉션도
삭제됩니다. 실행 전에 Radicale 데이터 디렉터리를 백업하는 것을 권장합니다.

## 5. CLI 설치

```bash
chmod +x /opt/haru/cli/todo.py
sudo ln -sfn /opt/haru/cli/todo.py /usr/local/bin/haru
```

기본 시험 서버가 아닌 다른 주소를 사용하면 환경 변수를 설정합니다.

```bash
export HARU_URL=https://example.com/haru
export HARU_USERNAME=admin
haru list
haru create newuser --role user
```

`HARU_PASSWORD`를 설정하지 않으면 CLI가 관리자 비밀번호를 안전하게 묻습니다. 자동화
환경에서만 `HARU_PASSWORD`를 비밀 환경 변수로 주입하고 셸 설정 파일이나 저장소에는
기록하지 않습니다.

새 계정의 임시 비밀번호는 생성 직후 한 번 표시되며 첫 로그인 후 변경해야 합니다.
권한은 `admin`, `user`, `guest` 중에서 지정할 수 있고 계정 및 권한 관리는 웹의 계정
정보 화면에서도 할 수 있습니다.

## 협업과 반복 태스크

같은 인스턴스 사용자는 자신이 소유한 리스트에 태스크를 추가할 때 제목 끝에
`@username` 또는 `@username@example.com`을 입력해 목록 협업을 요청할 수 있습니다.
초대받은 사용자는 상단 알림 창에서 승인 또는 거절하고, 승인된 공유는 계정 화면의
협업 권한에서 제거할 수 있습니다. 다른 인스턴스로의 요청은 연합 인증이 구현되기
전까지 전송하지 않고 오류로 처리합니다.

웹 입력 도구에서 매시간·매일·매주·매월·매년 반복을 지정할 수 있으며 CLI에서는
`--repeat daily`, `--repeat weekly:1`, `--repeat monthly:15`, `--repeat yearly:12-25`
형식을 사용합니다. 반복 태스크가 완료될 때 다음 회차가 만들어집니다.

## 6. PWA 설치

HTTPS로 Haru에 로그인한 뒤 브라우저의 **앱 설치** 버튼이나 주소창의 설치 메뉴를
사용합니다. 업데이트 후 이전 화면이 남아 있으면 앱을 완전히 닫았다가 다시 열거나
한 번 새로고침하여 새 Service Worker를 활성화합니다.

## 7. 업데이트와 백업

```bash
cd /opt/haru
cp -p data/store.json "data/store.json.$(date +%Y%m%d-%H%M%S).bak"
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 haru
```

Radicale을 사용하는 경우 Haru JSON 파일뿐 아니라 Radicale 저장소도 함께 백업합니다.

설정 화면의 **현재 기기 데이터 내보내기**는 브라우저에 저장된 리스트와 태스크를
리스트별 JSON 파일로 저장합니다. 값이 비어 있는 필드는 `"none"`으로 기록되고,
내보낸 시각·시간대·계정·기기 로캘은 `metadata`에 포함됩니다. **JSON 가져오기**는
없는 리스트와 태스크를 복구하고, 같은 이름의 기존 리스트에는 태스크를 병합합니다.
동일한 태스크를 다시 가져오면 중복 생성을 건너뜁니다.
