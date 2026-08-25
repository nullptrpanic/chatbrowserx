use axum::http::header;
use axum::response::{IntoResponse, Response};

const INDEX: &str = include_str!("assets/index.html");
const CSS: &str = include_str!("assets/app.css");
const JAVASCRIPT: &str = include_str!("assets/app.js");

pub(super) async fn index() -> Response {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], INDEX).into_response()
}

pub(super) async fn css() -> Response {
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], CSS).into_response()
}

pub(super) async fn javascript() -> Response {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        JAVASCRIPT,
    )
        .into_response()
}
