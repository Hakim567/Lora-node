from fastapi import APIRouter, Response, Request, HTTPException
from pydantic import BaseModel
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from config import AUTH_USERNAME, AUTH_PASSWORD, SECRET_KEY

router = APIRouter(prefix="/auth", tags=["auth"])

_serializer = URLSafeTimedSerializer(SECRET_KEY)
SESSION_COOKIE = "lora_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 7  # 7 days


def _sign(username: str) -> str:
    return _serializer.dumps(username, salt="session")


def verify_session(request: Request) -> str:
    """Return the authenticated username or raise 401."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        username = _serializer.loads(token, salt="session", max_age=SESSION_MAX_AGE)
        return username
    except (BadSignature, SignatureExpired):
        raise HTTPException(status_code=401, detail="Session expired or invalid")


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginRequest, response: Response):
    if body.username != AUTH_USERNAME or body.password != AUTH_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = _sign(body.username)
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=SESSION_MAX_AGE,
        path="/",
    )
    return {"status": "ok", "username": body.username}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(key=SESSION_COOKIE, path="/")
    return {"status": "ok"}


@router.get("/me")
def me(request: Request):
    username = verify_session(request)
    return {"username": username}
