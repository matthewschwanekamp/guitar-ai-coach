from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status

ErrorCode = str  # simple alias for readability


def build_error_response(
    error_code: ErrorCode,
    user_message: str,
    how_to_fix: Optional[List[str]] = None,
    debug_id: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "error_code": error_code,
        "user_message": user_message,
        "how_to_fix": how_to_fix or [],
    }
    if debug_id:
        payload["debug_id"] = debug_id
    if details:
        payload["details"] = details
    return payload


def raise_error(
    status_code: int,
    error_code: ErrorCode,
    user_message: str,
    how_to_fix: Optional[List[str]] = None,
    debug_id: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
) -> None:
    """Convenience helper to raise a FastAPI HTTPException with standard payload."""
    raise HTTPException(
        status_code=status_code,
        detail=build_error_response(error_code, user_message, how_to_fix, debug_id, details),
    )


def ensure_error_response(
    exc: HTTPException,
    fallback_code: ErrorCode = "INTERNAL_ERROR",
    how_to_fix: Optional[List[str]] = None,
    status_override: Optional[int] = None,
) -> HTTPException:
    """Wraps/normalizes an HTTPException detail into the standard schema."""
    if isinstance(exc.detail, dict) and exc.detail.get("error_code"):
        return exc
    payload = build_error_response(
        fallback_code,
        str(exc.detail) if exc.detail else fallback_code.replace("_", " ").title(),
        how_to_fix or ["Please try again."],
    )
    return HTTPException(status_code=status_override or exc.status_code, detail=payload)
