# 봇과 Passport API 계약

요청은 `PASSPORT_API_BASE_URL`에 대한 HTTPS와 Discord 전용 Bearer를 사용합니다. Minecraft 자격 증명·브라우저 쿠키는 이 경로에 사용하지 않습니다. 예제 ID와 값은 가상입니다.

## 개인 링크

`POST /v1/discord/link-sessions`는 기존 계약을 유지합니다.

```json
{
  "discordUserId": "100000000000000005",
  "guildId": "100000000000000002",
  "discordUsername": "example_user",
  "interactionId": "100000000000000008"
}
```

호출자 정보는 Discord interaction에서만 가져옵니다. 선택적 `discordDisplayName`은 봇이 보내지 않습니다. 응답은 `{id,url,expiresAt}`이며, 허용 웹 origin의 `/discord/link/{id}#token={opaque}`를 5분 동안 사용합니다. 반복 interaction·이미 연결된 계정은 409, 다른 guild는 403입니다. 링크는 호출자에게만 ephemeral 버튼으로 보냅니다.

## v2 설정과 작업 claim

매 claim 전 `GET /v2/discord/config`를 호출합니다.

```json
{
  "contractVersion": 2,
  "settingsRevision": "1",
  "guildId": "100000000000000002",
  "managedRoleIds": ["100000000000000003", "100000000000000010", "100000000000000011"],
  "nicknameEnabled": true
}
```

고정 env의 guild와 일치해야 합니다. 관리 역할은 중복 없는 양의 uint64 문자열 최대 256개이며 `@everyone`은 허용하지 않습니다. 설정 교체 후 회수해야 할 이전 역할도 목록에 포함합니다. 봇은 이 스냅샷을 각 작업에 결합하여, 다른 worker가 더 새 설정을 읽더라도 해당 작업의 권한 범위가 섞이지 않도록 합니다.

역할은 `POST /v2/discord/roles/claim`, 별명은 `POST /v2/discord/nicknames/claim`입니다.

```json
{ "contractVersion": 2, "guildId": "100000000000000002", "settingsRevision": "1", "limit": 10 }
```

역할 claim은 `limit:10`, 별명 claim은 `limit:4`를 보내며 응답도 요청한 상한을 넘으면 거절합니다.

설정이 달라지면 409 `discord_settings_changed`이며 변경을 수행하지 않고 다음 tick에 설정부터 다시 읽습니다. 응답은 `{contractVersion:2,jobs:[...]}`입니다.

| 공통 필드 | 의미 |
|---|---|
| `id` | 작업 UUID |
| `leaseToken` | 43자 base64url 난수 |
| `guildId`, `discordUserId` | 양의 uint64 십진 문자열 |
| `version` | 양의 signed int64 십진 문자열 |
| `expiresAt` | 최대 60초 lease의 ISO 시각 |

역할 작업에는 `roleId`, boolean `desired`, `kind:verification|member|semester`, `semester:null|YY-1|YY-2`가 있습니다. semester 종류만 학기 문자열을 사용합니다. 실제 학교·현재 회원·누적 학기 자격과 만료·정지 정책은 API가 계산하며 봇은 관리 목록에 있는 단일 역할만 변경합니다. 명부 탈락만으로 과거 학기 역할을 회수하지 않지만 학교 만료·통합 정지·연결 해제는 역할을 회수합니다. 학기 이력은 보존하여 같은 학교 사용자의 재연결 때 다시 판단합니다. 역할 교체 때 API는 같은 종류·학기의 이전 역할 회수 확인 전 새 지급을 보류합니다.

별명 작업에는 `nickname`이 있습니다. 문자열이면 공백을 정리한 1–32자 별명을 적용하고, null이면 **이 봇의 별명 관리 해제**입니다. API는 실명과 Minecraft 이름을 조합하고 봇은 별도 학교 정보를 조회하지 않습니다. `nicknameEnabled:false`여도 기존 관리 기록을 해제하는 null 작업은 처리합니다.

관리 해제 때 기록이 없으면 아무것도 바꾸지 않습니다. 기록이 있으면 현재 Discord 별명이 마지막 관리 별명과 같은 경우에만 원래 값으로 복원하고 기록을 지웁니다. 사용자가 이미 다른 별명으로 바꿨으면 그 값을 보존하고 기록만 지웁니다. 현재 별명이 우연히 원하는 값인 최초 동기화는 관리 소유권을 만들지 않습니다.

## 독립 ack와 오류

`POST /v2/discord/roles/{id}/ack` 또는 `POST /v2/discord/nicknames/{id}/ack`를 사용합니다.

```json
{ "contractVersion": 2, "leaseToken": "opaque", "version": "1", "outcome": "applied" }
```

공통 outcome은 `applied`, `retry`, `member_absent`, `configuration_error`입니다. 별명에는 `not_manageable`을 추가합니다. 서버 소유자나 봇과 같거나 높은 최고 역할은 별명 대상별 제한이며, Manage Nicknames 자체가 없거나 비공개 상태 파일이 손상된 경우는 설정 오류입니다. 닉네임 제한이 역할 작업의 claim·적용·ack를 막지 않습니다.

성공은 204, 만료·오래된 lease/version은 409 `discord_lease_stale`입니다. ack에는 닉네임·ID 목록·원본 오류·자격 증명을 넣지 않습니다. 외부 요청이 lease 뒤에 끝나면 성공 ack를 보내지 않습니다.

각 stream은 한 번에 하나의 batch만 진행합니다. 역할은 최대 10개를 사용자별로 묶어 서로 다른 사용자 2명까지 병렬 처리하고 같은 사용자의 역할은 순차 처리합니다. 별명은 최대 4개를 순차 처리합니다. ack의 API 오류가 발생하면 새 작업을 시작하지 않고 이미 진행 중인 작업까지 기다린 뒤 해당 stream을 장애 상태로 표시합니다. Discord 요청 시작 시 5.5초 이상 lease가 남아 있어야 하며 개별 요청은 최대 5초입니다. 역할은 단일 PUT/DELETE, 별명은 `{nick:...}`만 PATCH하며 전체 역할 배열을 보내지 않습니다.

성공 작업도 API가 다시 예약해 수동 변경·재가입·응답 유실에서 수렴합니다. Discord REST는 DB 트랜잭션이 아니므로 timeout 후 원격 변경을 취소했다고 가정하지 않습니다. 별명 PATCH 전 복원 원본을 비공개 로컬 journal에 기록하고, 불확실한 응답은 다음 조회에서 확인합니다. 역할/별명 작업·설정 revision·lease는 API DB가 보존합니다.
