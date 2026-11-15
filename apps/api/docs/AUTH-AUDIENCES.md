# Session audiences

## The defect this replaces

Browser cookies are scoped by **host and path, never by port**. The storefront
(`:8001`), the admin console (`:8001`) and the till (`:8002`) are all
`localhost`, so while they shared one `access_token` / `refresh_token` pair,
every surface accepted every session. Reproduced before the change:

| Action | Observed |
| --- | --- |
| Sign into the POS as `dev_cashier2` | The Web storefront header showed `dev_cashier2`; storefront `/auth/me` returned `roles: ["sale"], branchId: 1` |
| Sign out on the Web | Both cookies cleared; the POS session died (`/auth/me` → 401) |
| Sign into Admin as `dev_superadmin` | The POS tab silently became an admin session, and the POS chrome gained the sales-report link |
| Refresh on the Web | Rotated the one cookie pair the POS tabs depended on |

Port, `Origin`, `Referer` and `User-Agent` are either shared between these
surfaces or client-controlled, so none of them can carry the distinction.

## The model

A session belongs to exactly one **audience**: `storefront`, `admin`, or `pos`.
It is carried in two independent places, and **both are checked**, so neither is
load-bearing alone:

1. a signed `aud` claim on the access and refresh tokens
2. an `audience` column on the `refresh_tokens` row

`packages/api-client` and `apps/api/src/modules/auth/audience.ts` are the two
declarations of this model.

## Cookies

| Audience | Access cookie | Refresh cookie |
| --- | --- | --- |
| `storefront` | `kz_storefront_access` | `kz_storefront_refresh` |
| `admin` | `kz_admin_access` | `kz_admin_refresh` |
| `pos` | `kz_pos_access` | `kz_pos_refresh` |

All six carry `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and a `Max-Age`
taken from the same config value that signs the token they hold.

`Path` stays `/` deliberately. Scoping the admin cookie to `/admin` would scope
it on the *frontend's* path, while every surface calls the same API origin — so
a path scope would either break every call or mean nothing. Separation is
carried by the cookie NAME and the signed claim.

There is deliberately **no `domain`**: a host-only cookie is the narrowest the
browser offers. It does not separate ports — that is why the audience exists —
but widening it to a domain would additionally share the session with every
subdomain.

The pre-audience `access_token` / `refresh_token` cookies are no longer read by
anything and are actively cleared on any session write, so a browser that
authenticated before this change does not keep sending them.

## Routes

There is no shared `/auth/login`, `/auth/me` or `/auth/refresh-token`. Each
surface has its own, generated from a single class so they cannot drift:

| | storefront | admin | pos |
| --- | --- | --- | --- |
| password door | `POST /auth/storefront/review-login` * | `POST /auth/admin/login` | `POST /auth/pos/login` |
| OTP | `POST /auth/storefront/send-otp`, `POST /auth/storefront/verify-otp` | — | — |
| rotate | `POST /auth/storefront/refresh` | `POST /auth/admin/refresh` | `POST /auth/pos/refresh` |
| sign out (this surface) | `POST /auth/storefront/logout` | `POST /auth/admin/logout` | `POST /auth/pos/logout` |
| sign out everywhere | `POST /auth/storefront/logout-all` | `POST /auth/admin/logout-all` | `POST /auth/pos/logout-all` |
| introspect | `GET /auth/storefront/me` | `GET /auth/admin/me` | `GET /auth/pos/me` |

\* Review-only. It answers 403 unless `NODE_ENV !== 'production'` **and**
`KAZHAL_ENABLE_REVIEW_LOGIN=true`. Production customer authentication is OTP.

## Who may open a session

Decided **before any token is minted**, and re-decided on every rotation — never
by the frontend afterwards.

| Role | storefront | admin | pos |
| --- | --- | --- | --- |
| `site` | yes | no | no |
| `sale` | no | no | yes |
| `super_admin` | no | yes | yes † |
| deactivated | no | no | no |

† The administrator reads till reports from the POS surface. That is not a
licence to sell: `POST /orders/pos` separately requires a branch, so a
branchless administrator keeps report access and is refused the sale.

A refusal issues **no cookies at all**.

## Which session reaches which route

Every route that is not `@Public()` declares `@Audiences(...)`. A route with
several audiences lists them in a fixed order; the guard walks that order and
reads the first cookie present, so the choice is a property of the ROUTE and is
stable no matter what order cookies arrive in. `audience-coverage.int-spec.ts`
fails the build if any protected route omits the declaration.

The strategy then asserts that the signed `aud` claim matches **the cookie the
token arrived in** and that it is one the route serves — so renaming a cookie
cannot smuggle a token into a surface it was not issued for.

## The three kinds of sign-out

| | scope | endpoint |
| --- | --- | --- |
| **surface sign-out** | revokes this audience's refresh token, clears only its cookie pair. Other surfaces are untouched. | `POST /auth/<audience>/logout` |
| **global sign-out** | revokes every refresh token this user holds in every audience, on every device. Only the calling surface's cookies can be cleared; the others' refresh tokens are already dead and their access tokens expire within `JWT_ACCESS_EXPIRATION`. | `POST /auth/<audience>/logout-all` |
| **administrative revoke** | the same as global, performed by an administrator against another user. Clears nobody's cookies. | `POST /auth/users/:userId/revoke-sessions` |

There is no audience-wide sign-out across devices as a separate operation; it
was not required and inventing it would add a lever nobody asked for.

Password change and deactivation cut **every** audience at once: both are
re-checked on each request, each rotation and each websocket revalidation.

## Realtime

The handshake names the connecting surface in its query, the cookie for exactly
that audience is read, and the signed `aud` must agree. Rooms follow the
**surface**, not only the role:

- `storefront` joins only its own user room
- `pos` joins its user room and its branch room
- `admin` joins its user room, the `admins` room, and its branch room

So an administrator ringing up a sale is a cashier for that socket, and a
shopper who happens to be staff never joins a till's branch room. The periodic
revalidation sweep recomputes rooms from this same rule, so a role change cannot
grant a room the socket's audience is not entitled to.
