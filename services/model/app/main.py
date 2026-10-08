from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ai import AIError
from app.catalog import load_catalog
from app.edit_intent import EditIntent, EditIntentRequest, edit_intent
from app.optimize import OptimizeRequest, OptimizeResponse, optimize
from app.parse import ParseRequest, ParseResponse, PhotoRequest, PhotoStyles, parse, photo

app = FastAPI(title="clothing-recommendation model service")


@app.exception_handler(AIError)
def ai_unavailable(_: Request, e: AIError) -> JSONResponse:
    """Quota used up or every model overloaded: 503, so the API can tell the person to try again (not a bug)."""
    return JSONResponse(status_code=503, content={"detail": "ai_unavailable", "reason": str(e)[:300]})


@app.get("/health")
def health() -> dict:
    catalog = load_catalog()
    return {"status": "ok", "catalogVersion": catalog.version, "styleCount": len(catalog.styles)}


@app.post("/optimize", response_model=OptimizeResponse)
def optimize_course(req: OptimizeRequest) -> OptimizeResponse:
    return optimize(req)


@app.post("/parse", response_model=ParseResponse)
def parse_prompt(req: ParseRequest) -> ParseResponse:
    return parse(req)


@app.post("/photo", response_model=PhotoStyles)
def parse_photo(req: PhotoRequest) -> PhotoStyles:
    return photo(req)


@app.post("/edit-intent", response_model=EditIntent)
def course_edit_intent(req: EditIntentRequest) -> EditIntent:
    return edit_intent(req)
