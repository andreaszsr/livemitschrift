"""Notebook validation and page-scoped drawing operations."""
import hashlib
from typing import Annotated, Literal
from pydantic import Field, TypeAdapter, model_serializer, model_validator
from .protocol import MAX_PAGE_IMAGES, MAX_PAGE_TEXTS, MAX_TEXT_LENGTH, MessageModel
from .room import Client, ProtocolError, Room

MAX_POINTS = 2_000_000
MAX_HEIGHT = 1_000_000_000
Identity = Annotated[str, Field(pattern=r"^[a-zA-Z0-9-]{1,80}$")]
Title = Annotated[str, Field(min_length=1, max_length=200)]


class Point(MessageModel):
    x: float = Field(ge=0, le=1200)
    y: float = Field(ge=0, le=MAX_HEIGHT)
    pressure: float = Field(ge=0, le=1)


class Stroke(MessageModel):
    id: Identity
    color: str = Field(pattern=r"^#[a-fA-F0-9]{6}$")
    width: float = Field(ge=.5, le=20)
    order: int = Field(ge=0, le=9_007_199_254_740_990, strict=True)
    complete: bool
    points: list[Point] = Field(min_length=1, max_length=100_000)
    # Semi-transparent marker ink. Omitted for normal pen strokes.
    highlighter: Literal[True] | None = None

    @model_serializer(mode="wrap")
    def omit_default_tool(self, handler):
        # Keep stored/broadcast pen strokes byte-identical to clients that
        # never send the optional field.
        data = handler(self)
        if data.get("highlighter") is None:
            data.pop("highlighter", None)
        return data


class Background(MessageModel):
    asset_id: str = Field(alias="assetId", pattern=r"^[a-f0-9]{64}$")
    name: Title
    page_number: int = Field(alias="pageNumber", ge=1, le=1000)
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    fit_height: float | None = Field(default=None, alias="fitHeight", gt=0, le=MAX_HEIGHT)


# Rounding tolerance at the page edge, as in packages/core and the desktop storage.
EDGE = 1e-3
MIN_IMAGE_SIZE = 12


class PageImage(MessageModel):
    """Placement of an uploaded image (content-addressed asset) in document coordinates."""
    id: Identity
    asset_id: str = Field(alias="assetId", pattern=r"^[a-f0-9]{64}$")
    x: float = Field(ge=0, le=1200)
    y: float = Field(ge=0, le=MAX_HEIGHT)
    width: float = Field(ge=MIN_IMAGE_SIZE, le=1200)
    height: float = Field(ge=MIN_IMAGE_SIZE, le=MAX_HEIGHT)
    order: int = Field(ge=0, le=9_007_199_254_740_990, strict=True)

    @model_validator(mode="after")
    def inside_width(self) -> "PageImage":
        if self.x + self.width > 1200 + EDGE:
            raise ValueError("Image outside the page width.")
        return self


class PageText(MessageModel):
    """A typed text box; its height follows from the client's text layout and is not stored."""
    id: Identity
    x: float = Field(ge=0, le=1200)
    y: float = Field(ge=0, le=MAX_HEIGHT)
    width: float = Field(ge=60, le=1200)
    text: str = Field(min_length=1, max_length=MAX_TEXT_LENGTH)
    size: Literal["small", "medium", "large"]
    color: str = Field(pattern=r"^#[a-fA-F0-9]{6}$")
    code: bool = Field(strict=True)
    order: int = Field(ge=0, le=9_007_199_254_740_990, strict=True)

    @model_validator(mode="after")
    def inside_width(self) -> "PageText":
        if self.x + self.width > 1200 + EDGE or not self.text.strip():
            raise ValueError("Text box outside the page width or empty.")
        return self


def omit_empty_images(data: dict, *keys: str) -> dict:
    """Pages and edits without images keep their previous JSON form (and digests)."""
    for key in keys:
        if not data.get(key):
            data.pop(key, None)
    return data


class Page(MessageModel):
    id: Identity
    title: Title
    width: Literal[1200]
    height: float = Field(gt=0, le=MAX_HEIGHT)
    background: Background | None
    strokes: list[Stroke] = Field(max_length=50_000)
    images: list[PageImage] = Field(default_factory=list, max_length=MAX_PAGE_IMAGES)
    texts: list[PageText] = Field(default_factory=list, max_length=MAX_PAGE_TEXTS)
    next_order: int = Field(alias="nextOrder", ge=0, le=9_007_199_254_740_991)

    @model_serializer(mode="wrap")
    def omit_images(self, handler):
        return omit_empty_images(handler(self), "images", "texts")

    @model_validator(mode="after")
    def consistent(self) -> "Page":
        if len({s.id for s in self.strokes}) != len(self.strokes) or len({s.order for s in self.strokes}) != len(self.strokes):
            raise ValueError("Duplicate stroke identity/order.")
        if any(p.y > self.height for s in self.strokes for p in s.points) or any(s.order >= self.next_order for s in self.strokes):
            raise ValueError("Stroke outside page geometry/order.")
        if any(not s.complete for s in self.strokes[:-1]):
            raise ValueError("Only the last stroke may be active.")
        if len({i.id for i in self.images}) != len(self.images):
            raise ValueError("Duplicate image identity.")
        if any(i.y + i.height > self.height + EDGE or i.order >= self.next_order for i in self.images):
            raise ValueError("Image outside page geometry/order.")
        if len({t.id for t in self.texts}) != len(self.texts) or any(t.y > self.height or t.order >= self.next_order for t in self.texts):
            raise ValueError("Duplicate text box or text box outside page geometry/order.")
        return self


class Topic(MessageModel):
    id: Identity
    title: Title
    pages: list[Page] = Field(min_length=1, max_length=1000)


class Notebook(MessageModel):
    id: Identity
    title: Title
    topics: list[Topic] = Field(min_length=1, max_length=1000)


class Position(MessageModel):
    page_id: Identity = Field(alias="pageId")
    y: float = Field(ge=0, le=MAX_HEIGHT)
    focus_y: float | None = Field(default=None, alias="focusY", ge=0, le=MAX_HEIGHT)


class Snapshot(MessageModel):
    type: Literal["notebook"]
    notebook: Notebook
    position: Position

    @model_validator(mode="after")
    def consistent(self) -> "Snapshot":
        pages = [p for t in self.notebook.topics for p in t.pages]
        identities = [t.id for t in self.notebook.topics] + [p.id for p in pages]
        if len(pages) > 1000 or len(set(identities)) != len(identities):
            raise ValueError("Invalid page identities/count.")
        if sum(len(s.points) for p in pages for s in p.strokes) > MAX_POINTS:
            raise ValueError("Notebook point limit reached.")
        if sum(not s.complete for p in pages for s in p.strokes) > 1:
            raise ValueError("Only one stroke may be active.")
        page = next((p for p in pages if p.id == self.position.page_id), None)
        if page is None or self.position.y > page.height or (self.position.focus_y is not None and self.position.focus_y > page.height):
            raise ValueError("Unknown instructor position.")
        return self


class Start(MessageModel):
    type: Literal["stroke_start"]
    stroke: Stroke


class Points(MessageModel):
    type: Literal["stroke_points"]
    stroke_id: Identity
    points: list[Point] = Field(min_length=1, max_length=128)


class End(MessageModel):
    type: Literal["stroke_end"]
    stroke_id: Identity


class Ink(MessageModel):
    type: Literal["ink"]
    page_id: Identity = Field(alias="pageId")
    operation: Annotated[Start | Points | End, Field(discriminator="type")]


class Edit(MessageModel):
    id: Identity
    page_id: Identity = Field(alias="pageId")
    insert: list[Stroke] = Field(max_length=1000)
    remove: list[Identity] = Field(max_length=1000)
    insert_images: list[PageImage] = Field(default_factory=list, alias="insertImages", max_length=MAX_PAGE_IMAGES)
    remove_images: list[Identity] = Field(default_factory=list, alias="removeImages", max_length=MAX_PAGE_IMAGES)
    insert_texts: list[PageText] = Field(default_factory=list, alias="insertTexts", max_length=MAX_PAGE_TEXTS)
    remove_texts: list[Identity] = Field(default_factory=list, alias="removeTexts", max_length=MAX_PAGE_TEXTS)
    height: float = Field(gt=0, le=MAX_HEIGHT)

    @model_serializer(mode="wrap")
    def omit_images(self, handler):
        return omit_empty_images(handler(self), "insertImages", "removeImages", "insert_images", "remove_images",
                                 "insertTexts", "removeTexts", "insert_texts", "remove_texts")

    @model_validator(mode="after")
    def completed(self) -> "Edit":
        if any(not s.complete or any(p.y > self.height for p in s.points) for s in self.insert):
            raise ValueError("Expected completed strokes inside page extent.")
        if len(set(self.remove)) != len(self.remove) or len({s.id for s in self.insert}) != len(self.insert):
            raise ValueError("Duplicate edit identities.")
        if any(i.y + i.height > self.height + EDGE for i in self.insert_images):
            raise ValueError("Image outside page extent.")
        if len(set(self.remove_images)) != len(self.remove_images) or len({i.id for i in self.insert_images}) != len(self.insert_images):
            raise ValueError("Duplicate image identities.")
        if any(t.y > self.height for t in self.insert_texts):
            raise ValueError("Text box outside page extent.")
        if len(set(self.remove_texts)) != len(self.remove_texts) or len({t.id for t in self.insert_texts}) != len(self.insert_texts):
            raise ValueError("Duplicate text box identities.")
        return self


class EditEvent(MessageModel):
    type: Literal["edit"]
    edit: Edit


class Viewport(MessageModel):
    type: Literal["viewport"]
    position: Position


class Extent(MessageModel):
    type: Literal["extent"]
    page_id: Identity = Field(alias="pageId")
    height: float = Field(gt=0, le=MAX_HEIGHT)


class PointerPosition(MessageModel):
    x: float = Field(ge=0, le=1200)
    y: float = Field(ge=0, le=MAX_HEIGHT)


class Pointer(MessageModel):
    """Transient laser pointer; `point=None` hides it. Never persisted."""
    type: Literal["pointer"]
    page_id: Identity = Field(alias="pageId")
    point: PointerPosition | None


Event = Annotated[Ink | EditEvent | Viewport | Extent | Pointer, Field(discriminator="type")]
event_adapter: TypeAdapter[Event] = TypeAdapter(Event)


class NotebookRoom(Room):
    def __init__(self) -> None:
        super().__init__()
        self.state: Snapshot | None = None
        self.pages: dict[str, Page] = {}
        self.assets: dict[str, bytes] = {}
        self.point_count = 0
        self.active: tuple[str, str] | None = None
        self.edits: dict[str, str] = {}

    def apply(self, client: Client, event: Event) -> None:
        if client is not self.instructor or self.state is None:
            raise ProtocolError("The notebook viewer is read-only.")
        if isinstance(event, Viewport):
            page = self.pages.get(event.position.page_id)
            if page is None or event.position.y > page.height or (event.position.focus_y is not None and event.position.focus_y > page.height):
                raise ProtocolError("Viewport outside notebook.")
            self.state.position = event.position
        elif isinstance(event, Pointer):
            page = self.pages.get(event.page_id)
            if page is None or (event.point is not None and event.point.y > page.height):
                raise ProtocolError("Pointer outside notebook.")
        else:
            identity = event.edit.page_id if isinstance(event, EditEvent) else event.page_id
            page = self.pages.get(identity)
            if page is None:
                raise ProtocolError("Unknown page.")
            if isinstance(event, Extent):
                page.height = max(page.height, event.height)
            elif isinstance(event, EditEvent):
                edit = event.edit
                digest = hashlib.sha256(edit.model_dump_json(by_alias=True).encode()).hexdigest()
                if edit.id in self.edits:
                    if self.edits[edit.id] != digest:
                        raise ProtocolError("Conflicting edit identity.")
                    return
                removed = set(edit.remove)
                if self.active and self.active[0] == identity and self.active[1] in removed:
                    raise ProtocolError("Finish ink before erasing it.")
                strokes = [s for s in page.strokes if s.id not in removed]
                for stroke in edit.insert:
                    if any(s.id == stroke.id or s.order == stroke.order for s in strokes):
                        raise ProtocolError("Conflicting restored stroke.")
                    strokes.append(stroke)
                points = self.point_count - sum(len(s.points) for s in page.strokes) + sum(len(s.points) for s in strokes)
                if points > MAX_POINTS or len(strokes) > 50_000:
                    raise ProtocolError("Notebook ink limit reached.")
                page.strokes = sorted(strokes, key=lambda s: s.order)
                page.next_order = max(page.next_order, max((s.order + 1 for s in strokes), default=0))
                if edit.insert_images or edit.remove_images:
                    removed_images = set(edit.remove_images)
                    images = [i for i in page.images if i.id not in removed_images]
                    for image in edit.insert_images:
                        if any(i.id == image.id for i in images):
                            raise ProtocolError("Conflicting image identity.")
                        images.append(image)
                    if len(images) > MAX_PAGE_IMAGES:
                        raise ProtocolError("Page image limit reached.")
                    page.images = sorted(images, key=lambda i: i.order)
                    page.next_order = max(page.next_order, max((i.order + 1 for i in images), default=0))
                if edit.insert_texts or edit.remove_texts:
                    removed_texts = set(edit.remove_texts)
                    texts = [t for t in page.texts if t.id not in removed_texts]
                    for box in edit.insert_texts:
                        if any(t.id == box.id for t in texts):
                            raise ProtocolError("Conflicting text box identity.")
                        texts.append(box)
                    if len(texts) > MAX_PAGE_TEXTS:
                        raise ProtocolError("Page text box limit reached.")
                    page.texts = sorted(texts, key=lambda t: t.order)
                    page.next_order = max(page.next_order, max((t.order + 1 for t in texts), default=0))
                page.height = max(page.height, edit.height)
                self.point_count = points
                self.edits[edit.id] = digest
                if len(self.edits) > 4096:
                    del self.edits[next(iter(self.edits))]
            else:
                operation = event.operation
                if isinstance(operation, Start):
                    stroke = operation.stroke
                    if self.active or stroke.complete or len(stroke.points) != 1 or stroke.points[0].y > page.height:
                        raise ProtocolError("Invalid stroke start.")
                    if any(s.id == stroke.id or s.order == stroke.order for s in page.strokes) or len(page.strokes) >= 50_000 or self.point_count >= MAX_POINTS:
                        raise ProtocolError("Stroke identity/order or page limit.")
                    page.strokes.append(stroke)
                    page.next_order = max(page.next_order, stroke.order + 1)
                    self.active = (identity, stroke.id)
                    self.point_count += 1
                else:
                    if self.active != (identity, operation.stroke_id):
                        raise ProtocolError("Unknown active stroke.")
                    stroke = next(s for s in page.strokes if s.id == operation.stroke_id)
                    if isinstance(operation, End):
                        stroke.complete = True
                        self.active = None
                    else:
                        if self.point_count + len(operation.points) > MAX_POINTS or len(stroke.points) + len(operation.points) > 100_000 or any(p.y > page.height for p in operation.points):
                            raise ProtocolError("Stroke geometry/point limit.")
                        stroke.points.extend(operation.points)
                        self.point_count += len(operation.points)
        self.broadcast(event.model_dump(by_alias=True), source=client)
