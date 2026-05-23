/**
 * BetterFrame visual layout editor.
 *
 * Enhances the server-rendered CSS grid (.layout-builder) with:
 *   - Click-to-select cells
 *   - Drag edges to resize (col_span / row_span)
 *   - Drag cells to reposition (row / col)
 *   - Visual feedback (selection highlight, resize handles)
 *
 * No external deps. Communicates with the server via htmx-compatible
 * fetch calls (POST to /admin/layouts/:id/cells/:cellId with the new
 * row/col/spans). Server re-renders the grid fragment.
 *
 * Activated by adding data-layout-editor="<layoutId>" to the grid container.
 */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", init);
  // Also init on htmx swap (grid may be re-rendered).
  document.addEventListener("htmx:afterSettle", init);

  function init() {
    document.querySelectorAll("[data-layout-editor]").forEach(setupEditor);
  }

  function setupEditor(grid) {
    if (grid._bfEditorInit) return;
    grid._bfEditorInit = true;

    const layoutId = grid.getAttribute("data-layout-editor");
    const cells = grid.querySelectorAll(".layout-cell");

    cells.forEach(function (cell) {
      // Add resize handles.
      ["right", "bottom", "corner"].forEach(function (dir) {
        var handle = document.createElement("div");
        handle.className = "bf-resize-handle bf-resize-" + dir;
        handle.addEventListener("mousedown", function (e) {
          e.preventDefault();
          e.stopPropagation();
          startResize(grid, cell, dir, e, layoutId);
        });
        cell.appendChild(handle);
      });

      // Click to select (for future inline editing).
      cell.addEventListener("click", function () {
        cells.forEach(function (c) { c.classList.remove("bf-selected"); });
        cell.classList.add("bf-selected");
      });

      // Drag to move.
      cell.setAttribute("draggable", "true");
      cell.addEventListener("dragstart", function (e) {
        e.dataTransfer.setData("text/plain", cell.getAttribute("data-cell-id"));
        cell.classList.add("bf-dragging");
      });
      cell.addEventListener("dragend", function () {
        cell.classList.remove("bf-dragging");
      });
    });

    // Drop target for repositioning.
    grid.addEventListener("dragover", function (e) { e.preventDefault(); });
    grid.addEventListener("drop", function (e) {
      e.preventDefault();
      var cellId = e.dataTransfer.getData("text/plain");
      if (!cellId) return;

      // Calculate target grid position from mouse position.
      var rect = grid.getBoundingClientRect();
      var style = getComputedStyle(grid);
      var cols = style.gridTemplateColumns.split(" ").length;
      var rows = style.gridTemplateRows.split(" ").length;
      var cellW = rect.width / cols;
      var cellH = rect.height / rows;
      var targetCol = Math.floor((e.clientX - rect.left) / cellW);
      var targetRow = Math.floor((e.clientY - rect.top) / cellH);

      // POST the new position to the server.
      fetch("/admin/layouts/" + layoutId + "/cells/" + cellId + "/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row: targetRow, col: targetCol }),
      }).then(function () {
        // Trigger htmx to re-render the grid.
        htmx.trigger(grid, "bf-grid-changed");
      });
    });
  }

  var resizeState = null;

  function startResize(grid, cell, direction, startEvent, layoutId) {
    var cellId = cell.getAttribute("data-cell-id");
    var rect = grid.getBoundingClientRect();
    var style = getComputedStyle(grid);
    var cols = style.gridTemplateColumns.split(" ").length;
    var rows = style.gridTemplateRows.split(" ").length;
    var cellW = rect.width / cols;
    var cellH = rect.height / rows;

    var startX = startEvent.clientX;
    var startY = startEvent.clientY;
    var startColSpan = parseInt(cell.style.gridColumnEnd?.replace("span ", "") || "1");
    var startRowSpan = parseInt(cell.style.gridRowEnd?.replace("span ", "") || "1");

    function onMove(e) {
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var newColSpan = startColSpan;
      var newRowSpan = startRowSpan;

      if (direction === "right" || direction === "corner") {
        newColSpan = Math.max(1, startColSpan + Math.round(dx / cellW));
      }
      if (direction === "bottom" || direction === "corner") {
        newRowSpan = Math.max(1, startRowSpan + Math.round(dy / cellH));
      }

      cell.style.gridColumnEnd = "span " + newColSpan;
      cell.style.gridRowEnd = "span " + newRowSpan;
    }

    function onUp(e) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      var newColSpan = parseInt(cell.style.gridColumnEnd?.replace("span ", "") || "1");
      var newRowSpan = parseInt(cell.style.gridRowEnd?.replace("span ", "") || "1");

      if (newColSpan !== startColSpan || newRowSpan !== startRowSpan) {
        fetch("/admin/layouts/" + layoutId + "/cells/" + cellId + "/resize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ col_span: newColSpan, row_span: newRowSpan }),
        }).then(function () {
          htmx.trigger(grid, "bf-grid-changed");
        });
      }
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
})();
