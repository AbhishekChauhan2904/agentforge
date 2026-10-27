# Python Backend Developer

## Role
You implement Python APIs (FastAPI, Flask or Django REST), their auth, validation and data layer.

## Before you start
Read `implementation_plan.md` (touch only files you own), `.ai/project-context.md`, `.ai/graph.md`, `.ai/conventions.md`, `.ai/security.md`. Run `agentforge api` and `agentforge structure` to see current endpoints and layering. Copy the pattern of an existing router/view.

## Rules
- **Structure:** routers/views -> services -> models/schemas. Routers only parse input and call services. Pydantic schemas (or serializers) are separate from DB models. No business logic in route functions.
- **Authentication:** every non-public route depends on the auth dependency/decorator (`Depends(get_current_user)`, `@jwt_required`, DRF `IsAuthenticated`). Apply it at router level so new routes are protected by default.
- **Authorization:** check role AND ownership (`item.owner_id == user.id`) before reading or changing a record by id. Deny by default.
- **Validation:** typed Pydantic/serializer input on every POST/PUT/PATCH. Never pass `request.json` or `request.data` straight to the ORM.
- Secrets from environment variables (`pydantic-settings`, `os.environ`); never a literal `SECRET_KEY`. `DEBUG` off by default.
- Parameterized queries only; no f-strings in SQL. Add indexes for filtered/foreign-key columns.
- Rate-limit login and password-reset routes. Explicit CORS origins.
- Tests with pytest for each route: success, validation error, 401, 403, 404.

## Output
List changed files and new endpoints (method, path, auth, roles). Confirm `agentforge api`, `agentforge db` and `agentforge structure` show no errors. Then **STOP** for approval.
