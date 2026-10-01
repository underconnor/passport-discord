# 봇과 Passport API 계약

모든 요청은 `PASSPORT_API_BASE_URL`에 대한 HTTPS POST이며 Discord 전용 `Authorization: Bearer`를 사용합니다. Minecraft 서비스 자격 증명과 브라우저 쿠키는 이 경로에 사용하지 않습니다. 이 문서의 ID와 토큰 표기는 실제 운영 값이 아닙니다.

## 개인 링크 생성

`POST /v1/discord/link-sessions`

```json
{
  "discordUserId": "100000000000000005",
  "guildId": "100000000000000002",
  "discordUsername": "example_user",
  "interactionId": "100000000000000008"
}
```

ID는 Discord interaction에서 가져온 0보다 큰 uint64 십진 문자열입니다. API는 선택적 `discordDisplayName`도 받지만 봇은 전송하지 않습니다. 응답은 `{id, url, expiresAt}`이며 링크는 허용한 웹 origin의 `/discord/link/{id}#token={opaque}`입니다. TTL은 300초이고 API는 토큰 해시만 저장합니다. 같은 interaction 재사용과 이미 연결된 계정은 409, 다른 guild는 403입니다.

## 역할 작업

`POST /v1/discord/roles/claim`

```json
{ "guildId": "100000000000000002", "limit": 2 }
```

응답 `{jobs: [...]}`의 각 항목은 다음 필드를 가집니다.

| 필드 | 의미 |
|---|---|
| `id` | 작업 UUID |
| `leaseToken` | 43자 base64url 난수 |
| `guildId`, `discordUserId`, `roleId` | uint64 십진 문자열 |
| `desired` | 역할 존재 여부 boolean |
| `version` | 양의 십진 문자열. JSON 숫자로 변환하지 않음 |
| `expiresAt` | UTC ISO 시각. 최대 60초이며 지급 작업은 알려진 자격 만료 시각까지로 제한 |

봇은 한 번에 최대 2개를 순차 처리합니다. guild/role이 로컬 설정과 다르면 Discord 변경 없이 설정 오류로 보고합니다. Discord 요청 시작에 5.5초 이상 lease가 남아 있어야 하며 각 요청은 최대 5초만 기다립니다.

`POST /v1/discord/roles/{id}/ack`

```json
{ "leaseToken": "opaque", "version": "1", "outcome": "applied" }
```

허용 outcome은 `applied`, `retry`, `member_absent`, `configuration_error`뿐입니다. 성공 응답은 204이며 현재 lease/버전과 다르거나 만료되면 409 `discord_lease_stale`입니다. 상류 오류 문구나 회원 정보는 ack에 포함하지 않습니다. 이미 만료된 외부 응답에는 ack를 보내지 않습니다.

desired가 바뀌어도 API는 진행 중 lease를 보존합니다. 이전 ack는 버전 불일치로 거절하고 최신 작업을 다시 예약합니다. 성공도 60초 후 재확인하고, 회원 부재는 60초, 설정 오류는 300초, 일시 오류는 5~300초 지수 backoff로 재시도합니다. 변경과 ack를 Discord까지 원자적으로 묶을 수 없으므로 API와 봇의 정상화 후 재조정이 필요합니다.

학교 인증, 최신 동의, 일대일 연결, 관리자 연결 해제, 명부/정지/만료에 따른 desired 계산과 작업 저장은 API 책임입니다. 봇은 별도 회원 DB나 권한 정책을 유지하지 않습니다.
