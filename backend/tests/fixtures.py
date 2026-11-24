import hashlib
SECRET = "7" * 64
IDENTITY = hashlib.sha256(SECRET.encode()).hexdigest()


def stroke(identity="saved", order=0):
    return {"id": identity, "order": order, "color": "#243147", "width": 3.5,
            "complete": True, "points": [{"x": 100, "y": 2000, "pressure": .2}]}


def snapshot():
    def page(identity, ink):
        return {"id": identity, "title": "Seite", "width": 1200, "height": 6400,
                "background": None, "nextOrder": 1, "strokes": ink}
    return {"type": "notebook", "notebook": {"id": "book", "title": "Mathematik",
            "topics": [{"id": "topic", "title": "Folien", "pages": [page("a", [stroke()]), page("b", [])]}]},
            "position": {"pageId": "a", "y": 1800, "focusY": 2000}}

