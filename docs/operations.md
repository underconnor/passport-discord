# 설치와 운영

## 설치 전 준비

운영자가 Discord Developer Portal에서 새 애플리케이션을 만들거나 사용할 기존 봇을 정합니다. 봇 토큰은 채팅·Git·이슈에 붙이지 말고 배포 호스트의 비밀 파일이나 비공개 환경 설정에 저장합니다. API의 `PASSPORT_DISCORD_SERVICE_TOKEN`은 별도 난수로 생성하고 두 서비스에만 전달합니다.

1. Developer Portal의 애플리케이션 ID를 확인합니다. Bot 설정에서 public bot 여부는 운영 정책에 맞게 정하고 privileged intents는 모두 꺼둡니다.
2. Installation에서 **Guild Install**을 사용하고 `bot`, `applications.commands` scopes를 선택합니다. HTTP Interactions Endpoint URL은 설정하지 않습니다. 이 봇은 outbound Gateway로 interaction을 받습니다.
3. 봇 권한으로 Manage Roles, View Channel, Send Messages, Read Message History를 선택합니다. 합산 permission bitfield는 `268504064`입니다. Administrator를 선택하지 않습니다.
4. 허용 서버에 봇을 설치하고 인증 역할을 준비합니다. 봇의 가장 높은 역할을 인증 역할보다 위로 옮깁니다. 인증 역할이 `@everyone` 또는 외부 연동 관리 역할이면 사용할 수 없습니다.
5. 인증 안내를 게시할 일반 텍스트 채널을 지정합니다. 채널 overwrite에서도 봇의 View Channel, Send Messages, Read Message History를 허용합니다.
6. README의 환경 값을 비공개 배포 설정에 넣습니다. API에도 같은 guild와 role, 전용 Bearer를 설정합니다. 서비스 계정이나 비밀 값을 공개 저장소에 추가하지 않습니다.

## 배포

Docker 이미지는 고정 Node 24 베이스 digest와 npm lockfile로 만듭니다. 컨테이너는 UID 1000으로 실행합니다. `/data`에 쓰기 가능한 지속 볼륨을 연결하고 API·Discord에 대한 outbound HTTPS/WSS 접근을 허용합니다. 상태 검사 `3102` 포트는 외부 호스트에 게시하지 않습니다.

```sh
docker build -t passport-discord:local .
```

실제 환경을 제공한 상태에서 `npm run commands:register`를 한 번 실행합니다. 이 명령은 guild 범위의 `/passport setup` 정의만 갱신합니다. 봇 서비스를 시작해 `/healthz`가 정상인지 확인한 뒤, 서버 관리 권한이 있는 운영자가 **지정된 인증 채널에서** `/passport setup`을 실행합니다. 다른 채널이나 권한 없는 호출은 비공개 거절 메시지로 끝납니다.

안내 메시지 ID는 `/data/panel.json`에 저장됩니다. 이후 setup 실행은 같은 메시지를 편집합니다. 메시지가 삭제되었으면 운영자의 setup 명령으로 다시 만들 수 있습니다. 상태 파일이 잘못되거나 다른 guild/channel을 가리키면 게시를 거부합니다. 파일 기록에 실패한 경우 게시된 메시지를 먼저 확인하고, 파일 권한을 고친 뒤 재실행하여 중복 안내를 피합니다.

## 최종 검증

- 관리 권한 없는 사용자의 setup과 다른 채널 호출이 거부되는지 확인합니다.
- 실제 회원이 버튼을 누르면 링크가 그 사용자에게만 보이는지 확인합니다.
- 동의·학교 로그인 후 본인 Discord가 연결되고 지정 역할이 붙는지 확인합니다.
- 같은 interaction 재사용·다른 Discord/학교 계정 연결·만료 링크를 거부하는지 확인합니다.
- 봇 재시작 뒤 이미 연결된 회원의 역할을 재조정하는지 확인합니다.
- 권한 정지·명부 만료·관리자 연결 해제 후 역할 제거와 API 상태를 대조합니다.
- 봇 역할을 인증 역할보다 아래로 이동시킨 경우 설정 오류를 보고하고 다른 역할을 변경하지 않는지 확인한 뒤 원래 위치로 복구합니다.

실제 Discord 메시지·사용자·토큰은 검증 로그나 공개 이슈에 기록하지 않습니다. 성공/실패 유형과 비식별 시각만 남깁니다. 역할 회수 검증은 해당 계정의 역할을 실제로 변경하므로 운영자의 승인된 테스트 계정으로 수행합니다.

## 장애와 복구

서비스 재시작이 API에 저장된 역할 작업을 삭제하지 않습니다. ack 전에 실패한 작업은 lease 만료 뒤 다시 claim하며, 중복 단일 역할 PUT/DELETE는 기존 상태를 덮어쓰지 않습니다. 429·일시 오류는 API의 지수 backoff로 재시도합니다. 회원 탈퇴는 60초, 설정 오류는 300초 뒤 재확인하도록 API가 예약합니다.

API와 봇이 모두 정상화되어야 Discord 역할이 최신 상태로 수렴합니다. Discord 자체에는 역할 TTL이 없으며 원격 REST 변경을 transaction으로 묶을 수도 없습니다. 응답 timeout 뒤에도 Discord가 이미 변경을 처리했을 수 있어 지속적인 재조정이 필요합니다. 민감한 운영에서는 장애 알림을 확인하고 필요하면 관리자가 해당 역할을 직접 회수합니다.

역할 권한·계층·설정 오류가 관측되면 `/healthz`도 503으로 바뀝니다. 같은 역할 작업의 재확인이 성공할 때 복구하며 API의 설정 오류 재시도 간격은 300초입니다. 메모리 사용을 제한하기 위해 미해결 설정 작업은 최대 4,096개를 기록하고, 이를 넘으면 설정 수정과 상태 대조 후 운영자가 재시작할 때까지 degraded를 유지합니다. 재시작 직후의 상태 검사는 아직 조회하지 않은 작업의 권한까지 증명하지 않으므로 중앙 역할 상태와 실제 역할 지급 검증을 함께 확인합니다.

guild나 인증 role ID 변경은 기존 역할의 자동 이전 기능이 아닙니다. 기존 역할 회수와 새 역할 등록을 확인하는 별도 운영 변경으로 진행합니다.

연동 해제는 관리자 웹의 전용 작업으로 처리합니다. 봇 토큰을 잃었거나 노출했다면 Developer Portal에서 재발급하고 비공개 배포 설정을 교체한 뒤 재시작합니다. API 전용 Bearer도 별도로 회전합니다. 토큰 원문을 오류 메시지나 명령행 인자에 넣지 않습니다.
