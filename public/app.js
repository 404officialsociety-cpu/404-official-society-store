const state = {
  products: [],
  filtered: [],
  cursor: null,
  hasNextPage: false,
  filter: "All",
  cart: JSON.parse(localStorage.getItem("404_cart") || "[]")
};

const $ = s => document.querySelector(s);
const money = n => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(window.__toast);
  window.__toast = setTimeout(() => el.classList.remove("show"), 2200);
}

function saveCart() {
  localStorage.setItem("404_cart", JSON.stringify(state.cart));
  renderCart();
}

function imageFor(p) {
  return p.images?.[0]?.url || p.variants?.find(v => v.image?.url)?.image?.url ||
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 1000'%3E%3Crect width='800' height='1000' fill='%23101010'/%3E%3Ctext x='50%25' y='50%25' fill='white' font-size='120' text-anchor='middle' dominant-baseline='middle' font-family='Arial'%3E404%3C/text%3E%3C/svg%3E";
}

function typeFor(p) {
  return p.productType || (p.tags || []).find(t => /hoodie|sweat|shirt|tee/i.test(t)) || "Collection";
}

function availableVariants(p) {
  return (p.variants || []).filter(v => v.availableForSale !== false);
}

function renderProducts() {
  const grid = $("#productGrid");
  if (!state.filtered.length) {
    grid.innerHTML = `<div class="empty-state">NO PRODUCTS MATCH THIS FILTER.</div>`;
    return;
  }

  grid.innerHTML = state.filtered.map((p, i) => {
    const variants = availableVariants(p);
    const first = variants[0];
    const image = imageFor(p);
    const isNew = (p.tags || []).some(t => String(t).toLowerCase() === "new") || i < 2;
    return `
      <article class="product-card">
        <div class="product-visual" data-view="${esc(p.id)}">
          <img loading="lazy" src="${esc(image)}" alt="${esc(p.title)}">
          ${isNew ? `<span class="badge">NEW</span>` : ""}
          <button class="quick-view" data-view="${esc(p.id)}">VIEW</button>
        </div>
        <div class="product-copy">
          <div class="product-line"><strong>${esc(p.title)}</strong><span>${money(first?.price || 0)}</span></div>
          <small>${esc(typeFor(p))}</small>
          ${variants.length > 1 ? `<select data-variant="${esc(p.id)}">${variants.map(v =>
            `<option value="${esc(v.id)}">${esc(v.title || "Default")} — ${money(v.price)}</option>`).join("")}</select>` : ""}
          <button class="add-button" data-add="${esc(p.id)}">ADD TO BAG <span>+</span></button>
        </div>
      </article>`;
  }).join("");

  $("#loadMore").hidden = !state.hasNextPage;
}

function applyFilter() {
  const needle = state.filter.toLowerCase();
  state.filtered = state.filter === "All"
    ? [...state.products]
    : state.products.filter(p =>
      typeFor(p).toLowerCase().includes(needle) ||
      (p.tags || []).some(t => String(t).toLowerCase().replace(/[-_]/g, " ").includes(needle.replace(/[-_]/g, " ")))
    );
  renderProducts();
}

async function loadProducts(reset = false) {
  if (reset) {
    state.products = [];
    state.cursor = null;
    state.hasNextPage = false;
  }

  $("#catalogStatus").textContent = reset || !state.products.length
    ? "CONNECTING TO SHOPIFY…"
    : "LOADING MORE…";

  try {
    const qs = state.cursor ? `?after=${encodeURIComponent(state.cursor)}` : "";
    const response = await fetch(`/api/products${qs}`, { headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Shopify catalog unavailable.");

    state.products.push(...(data.products || []));
    state.cursor = data.pageInfo?.endCursor || null;
    state.hasNextPage = Boolean(data.pageInfo?.hasNextPage);
    applyFilter();

    $("#catalogStatus").textContent =
      `${state.products.length} SHOPIFY PRODUCTS LOADED${state.hasNextPage ? " • MORE AVAILABLE" : ""}`;
  } catch (error) {
    $("#catalogStatus").textContent = "SHOPIFY CONNECTION ERROR";
    $("#productGrid").innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
    toast(error.message);
  }
}

function addProduct(productId) {
  const product = state.products.find(p => p.id === productId);
  if (!product) return;

  const select = document.querySelector(`[data-variant="${CSS.escape(productId)}"]`);
  const variants = availableVariants(product);
  const variantId = select?.value || variants[0]?.id;
  const variant = variants.find(v => v.id === variantId) || variants[0];

  if (!variant) return toast("THIS PRODUCT IS CURRENTLY UNAVAILABLE.");

  const key = `${product.id}::${variant.id}`;
  const existing = state.cart.find(x => x.key === key);
  if (existing) existing.quantity += 1;
  else state.cart.push({
    key,
    productId: product.id,
    variantId: variant.id,
    title: product.title,
    variantTitle: variant.title || "Default",
    price: Number(variant.price || 0),
    image: imageFor(product),
    quantity: 1
  });

  saveCart();
  toast("ADDED TO BAG");
}

function renderCart() {
  const count = state.cart.reduce((n, x) => n + x.quantity, 0);
  const total = state.cart.reduce((n, x) => n + x.quantity * x.price, 0);
  $("#bagCount").textContent = count;
  $("#cartTotal").textContent = money(total);
  $("#checkoutTotal").textContent = money(total);

  const target = $("#cartItems");
  if (!state.cart.length) {
    target.innerHTML = `<div class="empty-state">YOUR BAG IS EMPTY.</div>`;
    return;
  }

  target.innerHTML = state.cart.map((item, i) => `
    <div class="cart-item">
      <img src="${esc(item.image)}" alt="">
      <div class="cart-details">
        <strong>${esc(item.title)}</strong>
        <small>${esc(item.variantTitle)}</small>
        <div class="qty"><button data-qty="${i}" data-dir="-1">−</button><span>${item.quantity}</span><button data-qty="${i}" data-dir="1">+</button></div>
        <button class="remove" data-remove="${i}">REMOVE</button>
      </div>
      <b>${money(item.quantity * item.price)}</b>
    </div>
  `).join("");
}

function openPanel(id) {
  $("#overlay").classList.add("open");
  $(id).classList.add("open");
}

function closePanels() {
  document.querySelectorAll(".open").forEach(el => el.classList.remove("open"));
}

function showProduct(productId) {
  const p = state.products.find(x => x.id === productId);
  if (!p) return;
  const variants = availableVariants(p);
  $("#productDetail").innerHTML = `
    <div class="detail-media"><img src="${esc(imageFor(p))}" alt="${esc(p.title)}"></div>
    <div class="detail-copy">
      <p class="kicker">${esc(typeFor(p))}</p>
      <h3>${esc(p.title)}</h3>
      <p>${esc((p.description || "").replace(/<[^>]*>/g, " ").slice(0, 500))}</p>
      <div class="detail-price">${money(variants[0]?.price || 0)}</div>
      ${variants.length > 1 ? `<label class="detail-select">SELECT VARIANT<select id="detailVariant">${variants.map(v =>
        `<option value="${esc(v.id)}">${esc(v.title || "Default")} — ${money(v.price)}</option>`).join("")}</select></label>` : ""}
      <button class="checkout-button" id="detailAdd">ADD TO BAG</button>
    </div>`;
  $("#detailAdd").onclick = () => {
    const chosen = $("#detailVariant")?.value;
    const fakeSelect = chosen ? null : document.querySelector(`[data-variant="${CSS.escape(productId)}"]`);
    const variant = variants.find(v => v.id === (chosen || fakeSelect?.value)) || variants[0];
    if (!variant) return;
    const key = `${p.id}::${variant.id}`;
    const existing = state.cart.find(x => x.key === key);
    if (existing) existing.quantity++;
    else state.cart.push({ key, productId:p.id, variantId:variant.id, title:p.title, variantTitle:variant.title || "Default", price:Number(variant.price||0), image:imageFor(p), quantity:1 });
    saveCart();
    closePanels();
    toast("ADDED TO BAG");
  };
  openPanel("#productModal");
}

async function startCheckout() {
  if (!state.cart.length) return toast("YOUR BAG IS EMPTY.");
  $("#checkoutTotal").textContent = $("#cartTotal").textContent;
  closePanels();
  openPanel("#checkoutModal");
}

$("#checkoutForm").addEventListener("submit", async e => {
  e.preventDefault();
  const button = $("#payButton");
  const error = $("#checkoutError");
  error.textContent = "";
  button.disabled = true;
  button.textContent = "CREATING SECURE PAYMENT…";

  const form = new FormData(e.currentTarget);
  const customer = Object.fromEntries(form.entries());

  try {
    const response = await fetch("/api/create-payment", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        customer,
        items: state.cart.map(x => ({ variantId: x.variantId, quantity: x.quantity }))
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Unable to create payment.");

    const cashfree = window.Cashfree?.({ mode: data.mode || "sandbox" });
    if (!cashfree) throw new Error("Cashfree checkout could not load. Refresh and try again.");

    await cashfree.checkout({
      paymentSessionId: data.payment_session_id,
      redirectTarget: "_self"
    });
  } catch (err) {
    error.textContent = err.message || "Checkout failed.";
    button.disabled = false;
    button.textContent = "CONTINUE TO CASHFREE";
  }
});

async function handlePaymentReturn() {
  const params = new URLSearchParams(location.search);
  if (params.get("payment") !== "return" || !params.get("order_id")) return;

  const orderId = params.get("order_id");
  $("#catalogStatus").textContent = "CHECKING PAYMENT…";

  try {
    const r = await fetch(`/api/payment-status?order_id=${encodeURIComponent(orderId)}`);
    const d = await r.json();
    if (d.order_status === "PAID" || d.payment_status === "SUCCESS") {
      state.cart = [];
      saveCart();
      toast("PAYMENT SUCCESSFUL — ORDER RECEIVED.");
    } else {
      toast(`PAYMENT STATUS: ${d.order_status || d.payment_status || "PENDING"}`);
    }
  } catch {
    toast("PAYMENT RECEIVED. ORDER STATUS IS BEING CONFIRMED.");
  }

  history.replaceState({}, "", location.pathname);
}

document.addEventListener("click", e => {
  const add = e.target.closest("[data-add]");
  if (add) addProduct(add.dataset.add);

  const view = e.target.closest("[data-view]");
  if (view) showProduct(view.dataset.view);

  const remove = e.target.closest("[data-remove]");
  if (remove) {
    state.cart.splice(Number(remove.dataset.remove), 1);
    saveCart();
  }

  const qty = e.target.closest("[data-qty]");
  if (qty) {
    const i = Number(qty.dataset.qty);
    state.cart[i].quantity += Number(qty.dataset.dir);
    if (state.cart[i].quantity < 1) state.cart.splice(i, 1);
    saveCart();
  }

  const filter = e.target.closest("[data-filter]");
  if (filter) {
    state.filter = filter.dataset.filter;
    document.querySelectorAll("#filters button").forEach(b => b.classList.toggle("active", b === filter));
    applyFilter();
  }

  if (e.target.matches("[data-close]") || e.target.id === "overlay") closePanels();
});

$("#bagButton").onclick = () => openPanel("#bagDrawer");
$("#checkoutButton").onclick = startCheckout;
$("#reloadProducts").onclick = () => loadProducts(true);
$("#loadMore").onclick = () => loadProducts(false);

$("#searchButton").onclick = () => {
  openPanel("#searchModal");
  $("#searchInput").focus();
};

$("#searchInput").addEventListener("input", e => {
  const q = e.target.value.trim().toLowerCase();
  state.filtered = state.products.filter(p =>
    (p.title || "").toLowerCase().includes(q) ||
    (p.productType || "").toLowerCase().includes(q) ||
    (p.tags || []).some(t => String(t).toLowerCase().includes(q))
  );
  renderProducts();
});

$("#menuButton").onclick = () => $("#mobileMenu").classList.toggle("open");

window.addEventListener("scroll", () => $("#header").classList.toggle("scrolled", scrollY > 20));

renderCart();
loadProducts(true);
handlePaymentReturn();
