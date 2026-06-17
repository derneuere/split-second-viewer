/* Split/Second RE Wiki — chrome builder. Reads window.WIKI_NAV from nav.js. */
(function () {
  "use strict";
  var NAV = window.WIKI_NAV || [];
  function cur() { var p = location.pathname.split("/").pop(); return p || "index.html"; }
  var here = cur();

  // flat page list for search
  var PAGES = [];
  NAV.forEach(function (c) { (c.pages || []).forEach(function (p) {
    PAGES.push({ title: p.title, file: p.file, summary: p.summary || "", cat: c.cat });
  }); });

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "class") e.className = attrs[k]; else if (k === "html") e.innerHTML = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }

  function buildSidebar(filter) {
    var nav = document.getElementById("nav");
    if (!nav) return;
    nav.innerHTML = "";
    var f = (filter || "").trim().toLowerCase();
    var any = false;
    NAV.forEach(function (c) {
      var matches = (c.pages || []).filter(function (p) {
        if (!f) return true;
        return (p.title + " " + (p.summary || "")).toLowerCase().indexOf(f) >= 0;
      });
      if (!matches.length) return;
      any = true;
      nav.appendChild(el("div", { class: "cat" }, [c.cat]));
      var ul = el("ul");
      matches.forEach(function (p) {
        var a = el("a", { href: p.file, title: p.summary || p.title }, [p.title]);
        if (p.file === here) a.className = "active";
        ul.appendChild(el("li", null, [a]));
      });
      nav.appendChild(ul);
    });
    if (!any) nav.appendChild(el("div", { class: "empty" }, ["No pages match “" + filter + "”"]));
  }

  function buildBreadcrumb() {
    var bc = document.querySelector(".breadcrumb");
    if (!bc) return;
    var cat = document.body.getAttribute("data-category") || "";
    var title = document.body.getAttribute("data-title") || document.title;
    bc.innerHTML = "";
    bc.appendChild(el("a", { href: "index.html" }, ["Home"]));
    if (cat) { bc.appendChild(document.createTextNode("  ›  ")); bc.appendChild(document.createTextNode(cat)); }
    bc.appendChild(document.createTextNode("  ›  "));
    bc.appendChild(el("strong", null, [title]));
  }

  function buildTOC() {
    var toc = document.getElementById("toc");
    if (!toc) return;
    var heads = document.querySelectorAll("article h2, article h3");
    if (heads.length < 2) { toc.style.display = "none"; return; }
    var wrap = el("div");
    wrap.appendChild(el("div", { class: "toc-h" }, ["On this page"]));
    var n = 0;
    heads.forEach(function (h) {
      if (!h.id) h.id = "s" + (n++) + "-" + (h.textContent || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      var a = el("a", { href: "#" + h.id, class: h.tagName === "H3" ? "h3" : "h2" }, [h.textContent]);
      wrap.appendChild(a);
    });
    toc.appendChild(wrap);
    // scroll spy
    var links = toc.querySelectorAll("a");
    function spy() {
      var y = window.scrollY + 90, best = null;
      heads.forEach(function (h) { if (h.offsetTop <= y) best = h.id; });
      links.forEach(function (a) { a.classList.toggle("active", a.getAttribute("href") === "#" + best); });
    }
    window.addEventListener("scroll", spy, { passive: true }); spy();
  }

  function wireSearch() {
    var s = document.getElementById("search");
    if (!s) return;
    s.addEventListener("input", function () { buildSidebar(s.value); });
    s.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var f = s.value.trim().toLowerCase();
        var hit = PAGES.filter(function (p) { return (p.title + " " + p.summary).toLowerCase().indexOf(f) >= 0; })[0];
        if (hit) location.href = hit.file;
      }
    });
  }

  function wireMobile() {
    var t = document.getElementById("menu-toggle"), sb = document.getElementById("sidebar");
    if (t && sb) {
      t.addEventListener("click", function () { sb.classList.toggle("open"); });
      sb.addEventListener("click", function (e) { if (e.target.tagName === "A") sb.classList.remove("open"); });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    buildSidebar(""); buildBreadcrumb(); buildTOC(); wireSearch(); wireMobile();
  });
})();
