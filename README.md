# passport-discord

Discord의 인증 버튼을 누른 사람에게만 웹 링크를 보여주고, Passport에서 확인한 회원 상태에 따라 지정된 Discord 역할 하나를 동기화하는 봇입니다. 웹에서 Discord ID를 직접 입력하는 방식은 사용하지 않습니다. 연결 해제는 관리자에게 문의합니다.

Node.js 24와 고정 버전 `discord.js`를 사용합니다. 독립 저장소이며 다른 Passport 저장소나 비공개 계약 파일 없이 검사할 수 있습니다.

## 구현한 흐름

1. 관리자가 지정된 인증 채널에서 `/passport setup`을 실행합니다. 서버 관리 권한을 확인한 뒤 안내를 게시하거나 기존 안내를 갱신합니다. 봇 시작만으로 채널에 글을 쓰지 않습니다.
2. 회원이 버튼을 누르면 먼저 비공개 응답을 예약하고, Discord가 전달한 호출자의 user/guild/interaction으로 5분짜리 일회용 링크를 만듭니다. 링크는 호출자에게만 보이는 메시지의 버튼에 넣습니다.
3. 웹에서 대상 Discord 계정을 확인하고 개인정보 동의와 학교 로그인을 진행합니다. 웹 세션·동의·학교/명부 확인과 Discord 연결은 Passport API가 담당합니다.
4. 봇은 API의 지속 저장된 역할 작업을 받아 현재 역할을 확인하고, 지정된 인증 역할만 추가하거나 제거합니다. 다른 역할을 통째로 덮어쓰지 않습니다.

이미 연결된 계정은 임의로 다시 연결하지 않습니다. 버튼 연타는 제한하고, 링크·사용자 이름·Discord ID·메시지·상류 오류 본문·자격 증명은 로그에 출력하지 않습니다. 공개 안내에 개인 링크를 넣거나 개인 메시지(DM)를 보내지 않습니다.

## 실행과 검사

```sh
npm ci --ignore-scripts
npm run check
npm run commands:dry-run
```

테스트에는 실제 토큰이나 Discord 서버가 필요하지 않습니다. 로컬 HTTP 서버로 전용 Bearer와 응답 경계를 확인하고, 역할 권한·계층·lease 만료·stale ack·재시작 후 재조정·비공개 응답·관리자/채널 제한을 검증합니다.

운영 설정을 환경 변수 또는 비밀 파일로 제공한 뒤 명령 등록과 실행을 분리합니다.

```sh
npm run commands:register
npm start
```

명령 등록은 지정된 guild의 `passport` 명령만 생성/갱신합니다. 다른 애플리케이션 명령을 삭제하지 않습니다. 안내 게시에는 Discord 안에서 관리자의 `/passport setup` 실행이 추가로 필요합니다.

## 환경 변수

| 변수 | 용도 |
|---|---|
| `DISCORD_TOKEN` 또는 `DISCORD_TOKEN_FILE` | Developer Portal에서 발급한 봇 토큰 |
| `PASSPORT_DISCORD_SERVICE_TOKEN` 또는 `_FILE` | API의 Discord 전용 Bearer. Minecraft 서비스 토큰·봇 토큰과 별도 |
| `DISCORD_APPLICATION_ID` | Discord 애플리케이션 ID |
| `DISCORD_GUILD_ID` | 허용할 Discord 서버 ID |
| `DISCORD_MEMBER_ROLE_ID` | 봇이 관리할 인증 역할 ID. `@everyone` 사용 불가 |
| `DISCORD_SETUP_CHANNEL_ID` | 버튼과 setup 명령을 허용할 텍스트 채널 ID |
| `PASSPORT_API_BASE_URL` | API origin, 예: `https://api.passport.example/`. `/v1`은 코드에서 추가 |
| `PASSPORT_WEB_ORIGIN` | 생성된 개인 링크에 허용할 정확한 웹 origin |
| `PASSPORT_ALLOW_INSECURE_HTTP` | 기본 false. 격리 개발 환경에서만 HTTP를 명시적으로 허용 |
| `PASSPORT_STATE_FILE` | 기본 `/data/panel.json`. 안내 메시지 ID의 지속 저장 위치 |
| `BIND_HOST`, `PORT` | 상태 검사 바인드. 기본 `127.0.0.1:3102` |

비밀 파일과 같은 이름의 직접 환경 값을 동시에 지정하면 시작을 거부합니다. 실제 값은 `.env.example`에 넣지 말고 비공개 배포 설정에서 제공합니다. `/data`는 실행 UID 1000이 쓸 수 있는 지속 볼륨으로 준비합니다.

## Discord 설치

[설치 절차](docs/operations.md)를 따릅니다. 기본 Gateway intent는 **Guilds 하나**입니다. Message Content·Guild Members·Presence privileged intent를 켜지 않습니다. 필요한 회원은 알려진 ID를 사용해 REST로 조회하며 전체 회원 목록을 수집하지 않습니다.

봇에 필요한 권한은 Manage Roles, View Channel, Send Messages, Read Message History입니다. Administrator 권한은 필요하지 않습니다. 인증 역할은 봇의 가장 높은 역할보다 아래에 놓아야 하며, 연동으로 관리되는 역할은 선택할 수 없습니다. Discord 역할 자체의 권한은 서버 운영자가 정합니다.

## 역할 동기화와 장애 경계

5초마다 단일 worker가 최대 2개 작업을 claim합니다. API가 발급한 최대 60초 lease와 버전, guild/role ID를 확인하고 사용자별로 순차 처리합니다. 역할 지급 lease는 알려진 학교/명부 만료 시각을 넘지 않습니다. 모든 Discord HTTP 요청은 5초 제한을 적용하고 rate-limit 대기는 즉시 재시도 대상으로 반환합니다. 변경 직전에도 만료를 확인하며, 만료 후 도착한 결과는 성공으로 ack하지 않습니다. API의 stale ack 거절은 최신 작업으로 다시 수렴시킵니다.

API는 학교/명부 만료·정지·연결 해제로부터 desired 상태를 계산합니다. 성공한 작업도 60초 후 재조정하므로 역할 수동 제거와 재가입을 복구할 수 있습니다. 다른 guild나 role의 작업은 Discord를 변경하지 않고 설정 오류로 보고합니다. 봇 토큰이 설정 역할 외의 역할을 관리하도록 허용하는 API는 제공하지 않습니다.

**Discord 역할에는 자체 lease/TTL이 없습니다.** API·봇·Discord 장애 중 기존 역할이 자동 만료되거나 즉시 회수된다고 보장하지 않습니다. 5초는 클라이언트 요청 대기 제한이며 이미 전송된 Discord 변경의 원격 취소를 보장하지 않습니다. 응답을 잃은 작업은 재시도하고, 서비스 정상화 뒤 최신 desired 상태를 반복 적용합니다. Minecraft 플러그인의 lease 만료 차단과는 동작이 다릅니다. 봇이 모르는 사용자가 운영자에게서 수동으로 받은 역할은 전체 회원 검색으로 수집하거나 제거하지 않습니다.

`GET /healthz`는 Gateway 연결, 최근 API 작업 조회, 관측한 미해결 역할 설정 오류를 검사해 정상 200 또는 degraded 503을 반환합니다. 같은 작업이 유효한 ack로 복구되기 전까지 다른 회원의 성공으로 설정 오류를 숨기지 않습니다. 탈퇴한 회원은 전체 장애로 간주하지 않습니다. 회원·토큰·세션 정보는 노출하지 않으며, 역할별 설정/재시도 상태는 중앙 API가 보관합니다. 운영 상태 검사는 외부에 공개할 필요가 없습니다.

## 배포 상태

코드와 독립 테스트는 준비되어 있습니다. 실제 봇 토큰, 애플리케이션·서버·역할·채널 설정과 설치 승인이 있어야 Gateway 접속, 안내 게시, 실계정 학교 인증, 역할 지급·회수의 최종 검증을 진행할 수 있습니다. 실환경 검증 없이 운영 완료로 표시하지 않습니다.

남은 설치와 실계정 검증은 [DISC-01](https://github.com/underconnor/passport-discord/issues/1)에서 추적합니다. 서비스 간 요청 형식은 [봇 API 계약](docs/api-contract.md)에 정리했습니다.

## 공식 참고 문서

- [Interactions 응답 및 ephemeral 메시지](https://docs.discord.com/developers/interactions/receiving-and-responding): 초기 응답은 3초 내에 보내고 개인 링크는 ephemeral 응답으로 전달합니다.
- [역할 권한과 계층](https://docs.discord.com/developers/topics/permissions): 역할 변경에는 Manage Roles와 역할 계층 조건이 적용됩니다.
- [Guild REST API](https://docs.discord.com/developers/resources/guild): 개별 회원 조회와 단일 역할 추가/제거를 사용합니다. 전체 회원 목록 조회는 privileged intent가 필요한 별도 기능입니다.
- [Gateway intents](https://docs.discord.com/developers/events/gateway): 필요한 이벤트 범위만 요청합니다.
