'use strict';

/* =============================================================================
   Food Recipe Finder — script.js
   -----------------------------------------------------------------------------
   Vanilla JavaScript, no build step. Recipes are loaded live from TheMealDB.

   1.  Config & application state
   2.  Small utilities
   3.  API layer (fetch + async/await)
   4.  Favorites (Supabase)
   5.  Rendering helpers
   6.  Routing / views
   7.  Home view
   8.  Explore view (search + filters)
   9.  Categories view
   10. Favorites view
   11. Recipe detail modal
   12. Events & initialisation
   ============================================================================= */

/* -----------------------------------------------------------------------------
   1. Config & application state
   -------------------------------------------------------------------------- */
const API_BASE = 'https://www.themealdb.com/api/json/v1/1/';
const FAVORITES_KEY = 'foodRecipeFinder.favorites.v1';
const SHOPPING_KEY = 'foodRecipeFinder.shoppingList.v1';
const RECENT_KEY = 'foodRecipeFinder.recentlyViewed.v1';
const RECENT_LIMIT = 6;
const PAGE_SIZE = 12;
const FETCH_TIMEOUT = 15000;
const FALLBACK_IMAGE = 'assets/placeholder.svg';
const VIEW_NAMES = ['home', 'explore', 'categories', 'favorites', 'shopping', 'about'];
const POPULAR_CATEGORIES = ['Chicken', 'Beef', 'Seafood', 'Pasta', 'Vegetarian', 'Dessert', 'Breakfast', 'Side'];
const FILIPINO_AREA = 'Filipino';

const state = {
  favorites: [],
  shopping: [],
  recent: [],
  details: new Map(), // recipe id -> full recipe object from the API
  categories: [],
  areas: [],
  homePick: null,
  featured: [],
  exploreList: [],
  exploreVisible: PAGE_SIZE,
  exploreRequest: 0,
  homePicksRequest: 0,
  filipinoRequest: 0,
  categoryView: null,
  modalReturnFocus: null,
  modalRequest: 0,
  toastTimer: null,
};

let supabaseUser = null;

async function initializeSupabase() {
  if (!window.dbClient) {
    throw new Error('Supabase is not initialized. Check your index.html setup.');
  }

  const { data: sessionData, error: sessionError } =
    await window.dbClient.auth.getSession();

  if (sessionError) throw sessionError;

  if (sessionData.session?.user) {
    supabaseUser = sessionData.session.user;
    return supabaseUser;
  }

  const { data, error } = await window.dbClient.auth.signInAnonymously();

  if (error) throw error;

  supabaseUser = data.user || data.session?.user;

  if (!supabaseUser) {
    throw new Error('Could not create an anonymous Supabase session.');
  }

  return supabaseUser;
}

function requireSupabaseUser() {
  if (!supabaseUser) {
    throw new Error('Your Supabase session is not ready. Please refresh the page.');
  }

  return supabaseUser;
}

let referencePromise = null;
let homeLoaded = false;

const suggestionCache = new Map();
let suggestionTimer = null;
let suggestionRequest = 0;
let suggestionItems = [];
let suggestionActive = -1;

/* -----------------------------------------------------------------------------
   2. Small utilities
   -------------------------------------------------------------------------- */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** Escape text before putting it into HTML. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[character];
  });
}

/** Trim a value and turn null/undefined into an empty string. */
function text(value) {
  return (value ?? '').toString().trim();
}

/** Only allow real http(s) links from the API — never invent a URL. */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

/* =============================================================================
   Theme (light / dark)
   ============================================================================= */

const THEME_KEY = 'frf-theme';

function getPreferredTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch (error) {
    // ignore storage issues
  }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (error) {
    // ignore storage issues
  }
  const meta = document.getElementById('meta-theme-color') || document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'dark' ? '#1f1712' : '#FFF9F0');
  syncThemeToggle(next);
  return next;
}

function syncThemeToggle(theme) {
  const button = document.getElementById('theme-toggle');
  const icon = document.getElementById('theme-toggle-icon');
  if (!button) return;
  const dark = theme === 'dark';
  button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  button.setAttribute('title', dark ? 'Switch to light theme' : 'Switch to dark theme');
  button.setAttribute('aria-pressed', dark ? 'true' : 'false');
  if (icon) icon.innerHTML = '<use href="' + (dark ? '#icon-sun' : '#icon-moon') + '" />';
}

function initTheme() {
  applyTheme(getPreferredTheme());
}

function plural(count, singular, pluralForm) {
  return count === 1 ? singular : pluralForm;
}

function escapeSelector(value) {
  return window.CSS && typeof CSS.escape === 'function' ? CSS.escape(String(value)) : String(value);
}

/* -----------------------------------------------------------------------------
   3. API layer
   -------------------------------------------------------------------------- */
class ApiError extends Error {}

/** Fetch JSON from TheMealDB with a timeout and friendly error messages. */
async function apiRequest(endpoint, params = {}) {
  const url = new URL(API_BASE + endpoint);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new ApiError(`The recipe service replied with status ${response.status}. Please try again in a moment.`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') {
      throw new ApiError('The recipe service took too long to respond. Please try again.');
    }
    throw new ApiError('We could not reach TheMealDB. Check your internet connection and try again.');
  } finally {
    clearTimeout(timeout);
  }
}

/** Build the compact recipe shape used by cards. */
function summaryFromDetail(raw) {
  if (!raw || !raw.idMeal) return null;
  return {
    id: String(raw.idMeal),
    name: text(raw.strMeal) || 'Untitled recipe',
    thumb: text(raw.strMealThumb),
    category: text(raw.strCategory),
    area: text(raw.strArea),
  };
}

/** filter.php only returns id/name/thumbnail — category and area get filled in later. */
function summaryFromFilter(raw) {
  if (!raw || !raw.idMeal) return null;
  return {
    id: String(raw.idMeal),
    name: text(raw.strMeal) || 'Untitled recipe',
    thumb: text(raw.strMealThumb),
    category: '',
    area: '',
  };
}

async function apiSearchByName(name) {
  const data = await apiRequest('search.php', { s: name });
  return (data.meals || []).map(summaryFromDetail).filter(Boolean);
}

/** Shared helper for filter.php (ingredient, category or area). */
async function apiFilter(param, value) {
  const data = await apiRequest('filter.php', { [param]: value });
  return (data.meals || []).map(summaryFromFilter).filter(Boolean);
}

async function apiCategories() {
  const data = await apiRequest('categories.php');
  return (data.categories || [])
    .map((category) => ({
      name: text(category.strCategory),
      thumb: text(category.strCategoryThumb),
      description: text(category.strCategoryDescription),
    }))
    .filter((category) => category.name);
}

async function apiAreas() {
  const data = await apiRequest('list.php', { a: 'list' });
  return (data.meals || [])
    .map((entry) => text(entry.strArea))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/** Full recipe details, cached so opening the same recipe twice is instant. */
async function apiLookup(id) {
  if (!id) return null;
  const key = String(id);
  if (state.details.has(key)) return state.details.get(key);

  const data = await apiRequest('lookup.php', { i: key });
  const meal = (data.meals && data.meals[0]) || null;
  if (meal) state.details.set(key, meal);
  return meal;
}

async function apiRandom() {
  const data = await apiRequest('random.php');
  const meal = (data.meals && data.meals[0]) || null;
  if (meal && meal.idMeal) state.details.set(String(meal.idMeal), meal);
  return meal;
}

/** Categories + cuisines are loaded once and shared by the filters and category grids. */
function loadReferenceData(force = false) {
  if (force) referencePromise = null;

  if (!referencePromise) {
    referencePromise = Promise.allSettled([apiCategories(), apiAreas()]).then(([categories, areas]) => {
      state.categories = categories.status === 'fulfilled' ? categories.value : [];
      state.areas = areas.status === 'fulfilled' ? areas.value : [];
      populateFilterOptions();

      // If both requests failed, clear the cache so a retry actually refetches.
      if (!state.categories.length && !state.areas.length) referencePromise = null;

      return state;
    });
  }

  return referencePromise;
}

/* -----------------------------------------------------------------------------
   4. Favorites (Supabase)
   -------------------------------------------------------------------------- */

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((meal) => meal && meal.id)
      .map((meal) => ({
        id: String(meal.id),
        name: text(meal.name) || 'Untitled recipe',
        thumb: text(meal.thumb),
        category: text(meal.category),
        area: text(meal.area),
      }));
  } catch (error) {
    return [];
  }
}

// Favorites are now stored in Supabase.
function persistFavorites() {}

async function loadFavoritesFromSupabase() {
  const user = requireSupabaseUser();

  let { data, error } = await window.dbClient
    .from('favorites')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) throw error;

  // Migrate old localStorage favorites only when the database is empty.
  if ((!data || !data.length)) {
    const oldFavorites = loadFavorites();

    if (oldFavorites.length) {
      const rows = oldFavorites.map((meal) => ({
        user_id: user.id,
        recipe_id: String(meal.id),
        recipe_name: meal.name,
        image_url: meal.thumb || null,
      }));

      const { error: insertError } = await window.dbClient
        .from('favorites')
        .upsert(rows, { onConflict: 'user_id,recipe_id' });

      if (insertError) throw insertError;

      const result = await window.dbClient
        .from('favorites')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (result.error) throw result.error;
      data = result.data;
    }
  }

  state.favorites = (data || []).map((row) => ({
    id: String(row.recipe_id),
    name: text(row.recipe_name) || 'Untitled recipe',
    thumb: text(row.image_url),
    category: '',
    area: '',
  }));

  updateFavoriteUI();

  if (currentRoute() === 'favorites') {
    renderFavorites();
  }
}

function isFavorite(id) {
  const key = String(id);
  return state.favorites.some((meal) => meal.id === key);
}

async function addFavorite(meal) {
  if (!meal || !meal.id || isFavorite(meal.id)) return false;

  const user = requireSupabaseUser();

  const favorite = {
    user_id: user.id,
    recipe_id: String(meal.id),
    recipe_name: text(meal.name) || 'Untitled recipe',
    image_url: text(meal.thumb) || null,
  };

  const { error } = await window.dbClient
    .from('favorites')
    .upsert(favorite, { onConflict: 'user_id,recipe_id' });

  if (error) throw error;

  state.favorites.unshift({
    id: String(meal.id),
    name: favorite.recipe_name,
    thumb: text(meal.thumb),
    category: text(meal.category),
    area: text(meal.area),
  });

  updateFavoriteUI();
  return true;
}

async function removeFavorite(id) {
  const user = requireSupabaseUser();
  const key = String(id);

  const { error } = await window.dbClient
    .from('favorites')
    .delete()
    .eq('user_id', user.id)
    .eq('recipe_id', key);

  if (error) throw error;

  const before = state.favorites.length;
  state.favorites = state.favorites.filter((meal) => meal.id !== key);

  if (state.favorites.length === before) return false;

  updateFavoriteUI();
  return true;
}

/** Find a saved/loaded summary by id, without another network request. */
function findMealSummary(id) {
  const key = String(id);
  const pools = [
    state.homePick,
    ...state.featured,
    ...state.exploreList,
    ...((state.categoryView && state.categoryView.list) || []),
    ...state.recent,
    ...state.favorites,
  ];
  return pools.find((meal) => meal && meal.id === key) || null;
}

function updateFavoriteUI() {
  const count = state.favorites.length;

  const badge = $('#nav-fav-count');
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }

  const label = $('#favorites-count');
  if (label) {
    label.textContent = count
      ? `${count} ${plural(count, 'recipe', 'recipes')} saved to your account.`
      : 'Your saved recipes will appear here.';
  }

  $$('[data-save]').forEach(applySaveState);
}

function applySaveState(button) {
  const id = button.dataset.save;
  const saved = isFavorite(id);
  const summary = findMealSummary(id);
  const name = (summary && summary.name) || button.dataset.mealName || 'recipe';

  button.classList.toggle('is-saved', saved);
  button.setAttribute('aria-pressed', String(saved));
  button.setAttribute('aria-label', `${saved ? 'Remove' : 'Add'} ${name} ${saved ? 'from' : 'to'} favorites`);

  const label = button.querySelector('[data-save-label]');
  if (label) label.textContent = saved ? 'Saved' : 'Save';
}

/** Add or remove a favorite and keep every save button in sync. */
async function toggleFavorite(id) {
  const key = String(id);

  try {
    if (isFavorite(key)) {
      await removeFavorite(key);
      showToast('Removed from favorites.');
    } else {
      let summary = findMealSummary(key);

      if (!summary) {
        const detail = await apiLookup(key).catch(() => null);
        if (detail) summary = summaryFromDetail(detail);
      }

      if (!summary) {
        showToast('That recipe could not be loaded. Please try again.', {
          type: 'error',
        });
        return;
      }

      await addFavorite(summary);
      showToast(`Saved "${summary.name}" to your favorites.`);
    }

    if (currentRoute() === 'favorites') {
      renderFavorites();
    }
  } catch (error) {
    console.error('Favorite operation failed:', error);
    showToast('Could not update your favorites. Please try again.', {
      type: 'error',
    });
  }
}

/* -----------------------------------------------------------------------------
   4b. Shopping list (Supabase)
   -------------------------------------------------------------------------- */

function loadShopping() {
  try {
    const raw = localStorage.getItem(SHOPPING_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item) => item && item.key && item.name)
      .map((item) => ({
        key: String(item.key),
        name: text(item.name),
        measure: text(item.measure),
        recipeId: text(item.recipeId),
        recipeName: text(item.recipeName),
        checked: Boolean(item.checked),
      }));
  } catch (error) {
    return [];
  }
}

// Shopping list data is now stored in Supabase.
function persistShopping() {}

function shoppingKey(recipeId, name) {
  return `${recipeId}::${name.toLowerCase()}`;
}

async function loadShoppingFromSupabase() {
  const user = requireSupabaseUser();

  let { data, error } = await window.dbClient
    .from('shopping_items')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) throw error;

  // Migrate the old localStorage list only if Supabase has no items.
  if (!data || !data.length) {
    const oldItems = loadShopping();

    if (oldItems.length) {
      const rows = oldItems.map((item) => ({
        user_id: user.id,
        item_name: item.name,
        quantity: item.measure || '',
        is_checked: Boolean(item.checked),
        recipe_id: item.recipeId || null,
        recipe_name: item.recipeName || null,
      }));

      const { error: insertError } = await window.dbClient
        .from('shopping_items')
        .insert(rows);

      if (insertError) throw insertError;

      const result = await window.dbClient
        .from('shopping_items')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (result.error) throw result.error;
      data = result.data;
    }
  }

  state.shopping = (data || []).map((row) => ({
    dbId: row.id,
    key: shoppingKey(row.recipe_id || 'manual', row.item_name),
    name: text(row.item_name),
    measure: text(row.quantity),
    recipeId: text(row.recipe_id),
    recipeName: text(row.recipe_name),
    checked: Boolean(row.is_checked),
  }));

  updateShoppingUI();

  if (currentRoute() === 'shopping') {
    renderShopping();
  }
}

/** Add ingredients from a recipe to Supabase. */
async function addIngredientsToShopping(detail, { render = true } = {}) {
  const meal = summaryFromDetail(detail);
  if (!meal) return 0;

  const user = requireSupabaseUser();
  const ingredients = extractIngredients(detail);
  const existingKeys = new Set(state.shopping.map((item) => item.key));

  const newIngredients = ingredients.filter((ingredient) => {
    const key = shoppingKey(meal.id, ingredient.name);
    return !existingKeys.has(key);
  });

  if (!newIngredients.length) return 0;

  const rows = newIngredients.map((ingredient) => ({
    user_id: user.id,
    item_name: ingredient.name,
    quantity: ingredient.measure,
    is_checked: false,
    recipe_id: meal.id,
    recipe_name: meal.name,
  }));

  const { data, error } = await window.dbClient
    .from('shopping_items')
    .insert(rows)
    .select('id, item_name, quantity, is_checked, recipe_id, recipe_name');

  if (error) throw error;

  (data || []).forEach((row) => {
    state.shopping.push({
      dbId: row.id,
      key: shoppingKey(row.recipe_id || 'manual', row.item_name),
      name: text(row.item_name),
      measure: text(row.quantity),
      recipeId: text(row.recipe_id),
      recipeName: text(row.recipe_name),
      checked: Boolean(row.is_checked),
    });
  });

  updateShoppingUI();

  if (render) renderShopping();

  return (data || []).length;
}

function updateShoppingUI() {
  const total = state.shopping.length;
  const remaining = state.shopping.filter((item) => !item.checked).length;

  const badge = $('#shopping-badge');
  if (badge) {
    badge.textContent = String(remaining);
    badge.hidden = remaining === 0;
  }

  const shoppingButton = $('#nav-shopping-btn');
  if (shoppingButton) {
    shoppingButton.setAttribute('aria-label', remaining
      ? `Shopping list, ${remaining} unchecked ${plural(remaining, 'item', 'items')}`
      : 'Shopping list');
  }

  const count = $('#shopping-count');
  if (count) {
    count.textContent = total
      ? `${total} ${plural(total, 'item', 'items')} · ${total - remaining} checked`
      : 'No items yet';
  }

  const favoritesCount = $('#favorites-shopping-count');
  if (favoritesCount) {
    favoritesCount.textContent = String(total);
    favoritesCount.hidden = total === 0;
  }
}

function shoppingItemMarkup(item) {
  const key = escapeHtml(item.key);
  return `
    <li class="shopping-item${item.checked ? ' is-checked' : ''}" data-shopping-row="${key}">
      <label class="shopping-check">
        <input type="checkbox" data-shopping-toggle="${key}"${item.checked ? ' checked' : ''} />
        <span class="shopping-text">
          <span class="shopping-name">${escapeHtml(item.name)}</span>
          <span class="shopping-meta">${escapeHtml(item.measure)}${item.recipeName ? ` · ${escapeHtml(item.recipeName)}` : ''}</span>
        </span>
      </label>
      <button class="shopping-remove" type="button" data-shopping-remove="${key}" aria-label="Remove ${escapeHtml(item.name)} from the shopping list">
        <svg class="icon" aria-hidden="true"><use href="#icon-close" /></svg>
      </button>
    </li>`;
}

function renderShopping() {
  const list = $('#shopping-items');
  const empty = $('#shopping-empty');
  updateShoppingUI();
  if (!list) return;

  if (!state.shopping.length) {
    list.innerHTML = '';
    if (empty) {
      empty.hidden = false;
      renderStatus(empty, {
        title: 'Your shopping list is empty',
        message: 'Open a recipe and choose “Add ingredients”, or pull in everything from the recipes you have saved.',
        actions: [
          { label: 'Explore recipes', href: '#explore' },
          { label: 'Add ingredients from favorites', action: 'shopping-add-favorites', variant: 'btn-outline' },
        ],
        icon: 'basket',
      });
    }
    return;
  }

  if (empty) empty.hidden = true;
  list.innerHTML = state.shopping.map(shoppingItemMarkup).join('');
}

async function toggleShoppingItem(key, checked) {
  const item = state.shopping.find((entry) => entry.key === key);
  if (!item) return;

  try {
    const user = requireSupabaseUser();

    const { error } = await window.dbClient
      .from('shopping_items')
      .update({ is_checked: Boolean(checked) })
      .eq('user_id', user.id)
      .eq('id', item.dbId);

    if (error) throw error;

    item.checked = Boolean(checked);

    const row = document.querySelector(
      `[data-shopping-row="${escapeSelector(key)}"]`
    );

    if (row) {
      row.classList.toggle('is-checked', item.checked);
    }

    updateShoppingUI();
  } catch (error) {
    console.error('Shopping item update failed:', error);
    showToast('Could not update that item. Please try again.', {
      type: 'error',
    });
    renderShopping();
  }
}

async function removeShoppingItem(key) {
  const item = state.shopping.find((entry) => entry.key === key);
  if (!item) return;

  try {
    const user = requireSupabaseUser();

    const { error } = await window.dbClient
      .from('shopping_items')
      .delete()
      .eq('user_id', user.id)
      .eq('id', item.dbId);

    if (error) throw error;

    state.shopping = state.shopping.filter(
      (entry) => entry.key !== key
    );

    renderShopping();
    showToast('Item removed from your shopping list.');
  } catch (error) {
    console.error('Shopping item removal failed:', error);
    showToast('Could not remove that item. Please try again.', {
      type: 'error',
    });
  }
}

async function clearShoppingList() {
  if (!state.shopping.length) {
    showToast('Your shopping list is already empty.');
    return;
  }

  try {
    const user = requireSupabaseUser();

    const { error } = await window.dbClient
      .from('shopping_items')
      .delete()
      .eq('user_id', user.id);

    if (error) throw error;

    state.shopping = [];
    renderShopping();
    showToast('Shopping list cleared.');
  } catch (error) {
    console.error('Shopping list clearing failed:', error);
    showToast('Could not clear your shopping list.', {
      type: 'error',
    });
  }
}

async function clearCheckedShopping() {
  const checkedItems = state.shopping.filter((item) => item.checked);

  if (!checkedItems.length) {
    showToast('No checked items to clear.');
    return;
  }

  try {
    const user = requireSupabaseUser();

    const { error } = await window.dbClient
      .from('shopping_items')
      .delete()
      .eq('user_id', user.id)
      .eq('is_checked', true);

    if (error) throw error;

    state.shopping = state.shopping.filter((item) => !item.checked);
    renderShopping();
    showToast('Checked items removed.');
  } catch (error) {
    console.error('Checked items removal failed:', error);
    showToast('Could not remove checked items.', {
      type: 'error',
    });
  }
}

async function addRecipeToShopping(id) {
  const key = String(id);
  const detail = state.details.get(key) ||
    (await apiLookup(key).catch(() => null));

  if (!detail) {
    showToast('We could not load that recipe right now. Please try again.', {
      type: 'error',
    });
    return;
  }

  const meal = summaryFromDetail(detail);

  if (!extractIngredients(detail).length) {
    showToast('This recipe does not include ingredient details.', {
      type: 'error',
    });
    return;
  }

  try {
    const added = await addIngredientsToShopping(detail);

    if (!added) {
      showToast('Those ingredients are already on your shopping list.');
      return;
    }

    showToast(
      `Added ${added} ${plural(added, 'ingredient', 'ingredients')} from "${meal.name}" to your shopping list.`
    );
  } catch (error) {
    console.error('Adding recipe ingredients failed:', error);
    showToast('Could not add ingredients. Please try again.', {
      type: 'error',
    });
  }
}

async function addFavoritesToShopping() {
  if (!state.favorites.length) {
    showToast('Save a few recipes first, then their ingredients can be added here.', {
      type: 'error',
    });
    return;
  }

  const buttons = $$('[data-action="shopping-add-favorites"]');

  buttons.forEach((button) => {
    button.disabled = true;
    button.classList.add('is-busy');
  });

  try {
    let added = 0;
    let failed = 0;

    for (const group of chunk(state.favorites, 4)) {
      const details = await Promise.all(
        group.map((favorite) =>
          apiLookup(favorite.id).catch(() => null)
        )
      );

      for (const detail of details) {
        if (!detail) {
          failed += 1;
          continue;
        }

        try {
          added += await addIngredientsToShopping(detail, {
            render: false,
          });
        } catch (error) {
          failed += 1;
          console.error('Could not add favorite ingredients:', error);
        }
      }
    }

    renderShopping();

    if (added) {
      showToast(
        `Added ${added} ${plural(added, 'ingredient', 'ingredients')} from your favorites.`
      );
    } else if (failed === state.favorites.length) {
      showToast('We could not load your favorites right now. Please try again.', {
        type: 'error',
      });
    } else {
      showToast('Everything from your favorites is already on the shopping list.');
    }
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      button.classList.remove('is-busy');
    });
  }
}

/* -----------------------------------------------------------------------------
   4c. Recently viewed (localStorage)
   -------------------------------------------------------------------------- */
function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((meal) => meal && meal.id)
      .map((meal) => ({
        id: String(meal.id),
        name: text(meal.name) || 'Untitled recipe',
        thumb: text(meal.thumb),
        category: text(meal.category),
        area: text(meal.area),
      }))
      .slice(0, RECENT_LIMIT);
  } catch (error) {
    return [];
  }
}

function persistRecent() {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(state.recent));
  } catch (error) {
    // Recently viewed is a convenience — a storage failure should not stop browsing.
  }
}

function recordRecentlyViewed(detail) {
  const meal = summaryFromDetail(detail);
  if (!meal) return;
  state.recent = [meal, ...state.recent.filter((item) => item.id !== meal.id)].slice(0, RECENT_LIMIT);
  persistRecent();
  renderRecent();
}

function renderRecent() {
  const section = $('#recent-section');
  const grid = $('#recent-grid');
  if (!section || !grid) return;

  if (!state.recent.length) {
    section.hidden = true;
    grid.innerHTML = '';
    return;
  }

  section.hidden = false;
  renderCards(grid, state.recent);
}

function clearRecentlyViewed() {
  if (!state.recent.length) return;
  state.recent = [];
  persistRecent();
  renderRecent();
  showToast('Recently viewed recipes cleared.');
}

/* -----------------------------------------------------------------------------
   5. Rendering helpers
   -------------------------------------------------------------------------- */
function cardMarkup(meal, index = 0) {
  const saved = isFavorite(meal.id);
  const name = meal.name || 'Untitled recipe';
  const category = meal.category || 'Category not listed';
  const area = meal.area || 'Cuisine not listed';

  return `
    <article class="recipe-card" style="--i:${index}" data-meal="${escapeHtml(meal.id)}">
      <div class="card-media">
        <img src="${escapeHtml(meal.thumb || FALLBACK_IMAGE)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" />
        <button class="save-chip${saved ? ' is-saved' : ''}" type="button" data-save="${escapeHtml(meal.id)}" data-meal-name="${escapeHtml(name)}"
          aria-pressed="${saved}" aria-label="${saved ? 'Remove' : 'Add'} ${escapeHtml(name)} ${saved ? 'from' : 'to'} favorites">
          <svg class="icon" aria-hidden="true"><use href="#icon-heart" /></svg>
          <span data-save-label>${saved ? 'Saved' : 'Save'}</span>
        </button>
      </div>
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(name)}</h3>
        <p class="card-meta">
          <span class="chip" data-meta-category>${escapeHtml(category)}</span>
          <span class="chip chip-alt" data-meta-area>${escapeHtml(area)}</span>
        </p>
      </div>
      <div class="card-foot">
        <button class="btn btn-soft" type="button" data-open="${escapeHtml(meal.id)}">
          View Recipe
          <svg class="icon" aria-hidden="true"><use href="#icon-arrow" /></svg>
        </button>
      </div>
    </article>`;
}

function renderCards(container, meals) {
  if (!container) return;
  container.innerHTML = meals.map((meal, index) => cardMarkup(meal, index)).join('');
}

function appendCards(container, meals) {
  if (!container || !meals.length) return;
  container.insertAdjacentHTML('beforeend', meals.map((meal, index) => cardMarkup(meal, index)).join(''));
}

function skeletonMarkup(count = 8) {
  return Array.from({ length: count }, () => `
    <div class="skeleton-card" aria-hidden="true">
      <div class="sk sk-media"></div>
      <div class="sk sk-line" style="width:72%"></div>
      <div class="sk sk-line" style="width:46%"></div>
      <div class="sk sk-line" style="width:100%;height:36px;border-radius:10px"></div>
    </div>`).join('');
}

function skeletonCategoryMarkup(count = 8) {
  return Array.from({ length: count }, () => '<div class="category-card sk" aria-hidden="true"></div>').join('');
}

function statusMarkup({ title, message, actions = [], icon = 'bowl' }) {
  const actionsHtml = actions
    .map((action) => (action.href
      ? `<a class="btn ${action.variant || 'btn-primary'}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
      : `<button class="btn ${action.variant || 'btn-primary'}" type="button" data-action="${escapeHtml(action.action)}">${escapeHtml(action.label)}</button>`))
    .join('');

  return `
    <div class="status">
      <span class="status-icon" aria-hidden="true">
        <svg class="icon"><use href="#icon-${escapeHtml(icon)}" /></svg>
      </span>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
      ${actionsHtml ? `<div class="status-actions">${actionsHtml}</div>` : ''}
    </div>`;
}

function renderStatus(container, config) {
  if (!container) return;
  container.innerHTML = statusMarkup(config);
}

function categoryCardMarkup(category) {
  return `
    <button class="category-card" type="button" data-action="explore-category" data-value="${escapeHtml(category.name)}">
      <img src="${escapeHtml(category.thumb || FALLBACK_IMAGE)}" alt="${escapeHtml(category.name)} recipes" loading="lazy" decoding="async" />
      <span>${escapeHtml(category.name)}</span>
    </button>`;
}

/** Fill in category/cuisine on cards once the detail lookup catches up. */
function patchCardMeta(meal) {
  const selector = `.recipe-card[data-meal="${escapeSelector(meal.id)}"]`;
  $$(selector).forEach((card) => {
    const category = card.querySelector('[data-meta-category]');
    const area = card.querySelector('[data-meta-area]');
    if (category && meal.category) category.textContent = meal.category;
    if (area && meal.area) area.textContent = meal.area;
  });
}

/**
 * filter.php results have no category or cuisine, so look those up in the
 * background (in small batches) and patch the cards that are on screen.
 */
async function enrichMeals(meals) {
  const missing = meals.filter((meal) => !meal.category || !meal.area);
  if (!missing.length) return;

  for (const group of chunk(missing, 5)) {
    const details = await Promise.all(group.map((meal) => apiLookup(meal.id).catch(() => null)));
    details.forEach((detail) => {
      if (!detail) return;
      const summary = summaryFromDetail(detail);
      if (!summary) return;
      const meal = meals.find((entry) => entry.id === summary.id);
      if (!meal) return;
      meal.category = meal.category || summary.category;
      meal.area = meal.area || summary.area;
      patchCardMeta(meal);

      // A favorite may have been saved before its details arrived — keep it accurate.
      const saved = state.favorites.find((entry) => entry.id === summary.id);
      if (saved && (!saved.category || !saved.area)) {
        const nextCategory = saved.category || summary.category;
        const nextArea = saved.area || summary.area;
        if (nextCategory !== saved.category || nextArea !== saved.area) {
          saved.category = nextCategory;
          saved.area = nextArea;
          if (currentRoute() === 'favorites') renderFavorites();
        }
      }
    });
  }
}

function showToast(message, { type = 'info', duration = 2800 } = {}) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('is-error', type === 'error');
  toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), duration);
}

/* -----------------------------------------------------------------------------
   6. Routing / views
   -------------------------------------------------------------------------- */
function currentRoute() {
  const hash = location.hash.replace(/^#/, '');
  return VIEW_NAMES.includes(hash) ? hash : 'home';
}

function handleRoute() {
  const route = currentRoute();

  $$('.view').forEach((view) => {
    view.hidden = view.id !== `view-${route}`;
  });

  $$('[data-nav]').forEach((link) => {
    const active = link.dataset.nav === route;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  const shoppingButton = $('#nav-shopping-btn');
  if (shoppingButton) shoppingButton.classList.toggle('is-active', route === 'shopping');

  closeMobileNav();
  closeSuggestions();
  closeRecipeModal();
  updateHeaderState();
  window.scrollTo({ top: 0, behavior: 'auto' });

  const activeView = $(`#view-${route}`);
  const heading = activeView ? activeView.querySelector('h1') : null;
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }

  if (route === 'home') loadHome();
  if (route === 'explore') initExplore();
  if (route === 'categories') initCategories();
  if (route === 'favorites') renderFavorites();
  if (route === 'shopping') renderShopping();
}

/** Jump to Explore, re-running the current filters if we are already there. */
function goToExplore() {
  if (location.hash === '#explore') handleRoute();
  else location.hash = '#explore';
}

/** Pre-select a category or cuisine, then jump to Explore with that filter applied. */
async function goExploreWithFilter(selectSelector, value) {
  await loadReferenceData();
  clearExploreForm();

  // Keep the value available for populateFilterOptions(), which rebuilds the options.
  if (selectSelector === '#filter-area' && !state.areas.includes(value)) state.areas.push(value);

  const select = $(selectSelector);
  if (select) {
    const exists = Array.from(select.options).some((option) => option.value === value);
    if (!exists) {
      select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`);
    }
    select.value = value;
  }

  goToExplore();
}

/** Send the Explore page straight to a Filipino cuisine search. */
async function exploreAllFilipino() {
  await loadReferenceData();
  clearExploreForm();
  if (!state.areas.includes(FILIPINO_AREA)) state.areas.push(FILIPINO_AREA);
  const select = $('#filter-area');
  if (select) {
    const exists = Array.from(select.options).some((option) => option.value === FILIPINO_AREA);
    if (!exists) {
      select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(FILIPINO_AREA)}">${escapeHtml(FILIPINO_AREA)}</option>`);
    }
    select.value = FILIPINO_AREA;
  }
  if (location.hash !== '#explore') location.hash = '#explore';
  else runExploreSearch();
}

function goExploreWithCategory(categoryName) {
  return goExploreWithFilter('#filter-category', categoryName);
}

function goExploreWithArea(areaName) {
  return goExploreWithFilter('#filter-area', areaName);
}

function populateFilterOptions() {
  const categorySelect = $('#filter-category');
  if (categorySelect) {
    const current = categorySelect.value;
    categorySelect.innerHTML = '<option value="">Any category</option>'
      + state.categories.map((category) => `<option value="${escapeHtml(category.name)}">${escapeHtml(category.name)}</option>`).join('');
    categorySelect.value = state.categories.some((category) => category.name === current) ? current : '';
  }

  const areaSelect = $('#filter-area');
  if (areaSelect) {
    const current = areaSelect.value;
    areaSelect.innerHTML = '<option value="">Any cuisine</option>'
      + state.areas.map((area) => `<option value="${escapeHtml(area)}">${escapeHtml(area)}</option>`).join('');
    areaSelect.value = state.areas.includes(current) ? current : '';
  }
}

function clearExploreForm() {
  const form = $('#explore-form');
  if (form) form.reset();
  const mode = $('#search-mode');
  if (mode) mode.value = 'name';
}

/* -----------------------------------------------------------------------------
   7. Home view
   -------------------------------------------------------------------------- */
function loadHome() {
  if (homeLoaded) return;
  homeLoaded = true;
  loadHomePicks();
  loadHomeCategories();
  loadFilipinoPicks();
}

async function loadHomePicks() {
  const pickContainer = $('#hero-pick');
  const featuredGrid = $('#featured-grid');
  const requestId = ++state.homePicksRequest;

  if (pickContainer) {
    pickContainer.innerHTML = `
      <div class="pick-card pick-card-skeleton" aria-hidden="true">
        <div class="pick-media sk"></div>
        <div class="pick-body">
          <div class="sk sk-line" style="width:82%"></div>
          <div class="sk sk-line" style="width:52%"></div>
        </div>
      </div>`;
  }
  if (featuredGrid) featuredGrid.innerHTML = skeletonMarkup(3);

  try {
    // Four random recipes: one hero pick plus three featured cards.
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => apiRandom()));
    const meals = [];
    results.forEach((result) => {
      if (result.status !== 'fulfilled' || !result.value) return;
      const summary = summaryFromDetail(result.value);
      if (summary && !meals.some((meal) => meal.id === summary.id)) meals.push(summary);
    });

    if (!meals.length) {
      throw new ApiError('We could not fetch any recipes right now. Please check your connection and try again.');
    }
    if (requestId !== state.homePicksRequest) return;

    state.homePick = meals[0];
    state.featured = meals.slice(1, 4);
    renderHeroPick(state.homePick);
    renderCards(featuredGrid, state.featured);
  } catch (error) {
    if (requestId !== state.homePicksRequest) return;
    if (pickContainer) {
      pickContainer.innerHTML = `
        <div class="pick-error">
          <h2>Recipe of the moment</h2>
          <p>${escapeHtml(error.message)}</p>
          <button class="btn btn-outline" type="button" data-action="refresh-featured">Try again</button>
        </div>`;
    }
    renderStatus(featuredGrid, {
      title: 'Featured recipes are unavailable',
      message: error.message,
      actions: [{ label: 'Try again', action: 'refresh-featured', variant: 'btn-outline' }],
      icon: 'search',
    });
  }
}

function renderHeroPick(meal) {
  const container = $('#hero-pick');
  if (!container) return;

  container.innerHTML = `
    <div class="pick-card">
      <div class="pick-media">
        <img src="${escapeHtml(meal.thumb || FALLBACK_IMAGE)}" alt="${escapeHtml(meal.name)}" />
        <span class="pick-badge">Today's pick</span>
      </div>
      <div class="pick-body">
        <h2>${escapeHtml(meal.name)}</h2>
        <p class="pick-meta">
          <span class="chip">${escapeHtml(meal.category || 'Category not listed')}</span>
          <span class="chip chip-alt">${escapeHtml(meal.area || 'Cuisine not listed')}</span>
        </p>
        <button class="btn btn-soft pick-cta" type="button" data-open="${escapeHtml(meal.id)}">
          View Recipe
          <svg class="icon" aria-hidden="true"><use href="#icon-arrow" /></svg>
        </button>
      </div>
    </div>`;
}

async function loadHomeCategories(force = false) {
  const grid = $('#home-categories');
  if (!grid) return;

  grid.innerHTML = skeletonCategoryMarkup(POPULAR_CATEGORIES.length);

  try {
    await loadReferenceData(force);
    if (!state.categories.length) {
      throw new ApiError('We could not load the category list from TheMealDB. Please try again.');
    }

    const picks = POPULAR_CATEGORIES
      .map((name) => state.categories.find((category) => category.name.toLowerCase() === name.toLowerCase()))
      .filter(Boolean);

    if (!picks.length) {
      throw new ApiError('The expected categories were not returned by TheMealDB. Please try again.');
    }

    grid.innerHTML = picks.map(categoryCardMarkup).join('');
  } catch (error) {
    renderStatus(grid, {
      title: 'Categories are unavailable',
      message: error.message,
      actions: [{ label: 'Try again', action: 'refresh-categories', variant: 'btn-outline' }],
    });
  }
}

/**
 * Show every Filipino recipe TheMealDB has. "Filipino" is a real area in the
 * API, so this stays live data — nothing here is hard-coded or invented.
 */
async function loadFilipinoPicks() {
  const grid = $('#filipino-grid');
  if (!grid) return;

  // The Explore link is a cuisine search, so it needs the reference data for the
  // cuisine option. Loading it here keeps that click fast.
  await loadReferenceData();

  const requestId = ++state.filipinoRequest;
  grid.innerHTML = skeletonMarkup(8);

  try {
    const meals = await apiFilter('a', FILIPINO_AREA);
    if (requestId !== state.filipinoRequest) return;
    if (!meals.length) {
      throw new ApiError('TheMealDB did not return any Filipino recipes just now. Please try again.');
    }

    // The area is known from the request, so the cards can show it immediately.
    meals.forEach((meal) => { meal.area = FILIPINO_AREA; });
    renderCards(grid, meals);
    enrichMeals(meals);

    const link = $('#filipino-explore');
    if (link) {
      link.textContent = `Explore ${meals.length} Filipino ${plural(meals.length, 'recipe', 'recipes')}`;
    }
  } catch (error) {
    if (requestId !== state.filipinoRequest) return;
    renderStatus(grid, {
      title: 'Filipino recipes are unavailable',
      message: error.message,
      actions: [{ label: 'Try again', action: 'refresh-filipino', variant: 'btn-outline' }],
    });
  }
}

/* -----------------------------------------------------------------------------
   8. Explore view (search + filters)
   -------------------------------------------------------------------------- */
async function initExplore() {
  await loadReferenceData();
  populateFilterOptions();
  runExploreSearch();
}

async function runExploreSearch() {
  const results = $('#explore-results');
  const title = $('#explore-title');
  const subtitle = $('#explore-sub');
  const loadMoreButton = $('#load-more');

  const query = text($('#explore-search') ? $('#explore-search').value : '');
  const mode = $('#search-mode') && $('#search-mode').value === 'ingredient' ? 'ingredient' : 'name';
  const category = $('#filter-category') ? $('#filter-category').value : '';
  const area = $('#filter-area') ? $('#filter-area').value : '';

  closeSuggestions();
  const requestId = ++state.exploreRequest;

  if (title) title.textContent = 'Searching…';
  if (subtitle) subtitle.textContent = 'Talking to TheMealDB.';
  if (results) {
    results.setAttribute('aria-busy', 'true');
    results.innerHTML = skeletonMarkup(8);
  }
  if (loadMoreButton) loadMoreButton.hidden = true;

  try {
    const meals = await buildResultPool({ query, mode, category, area });
    if (requestId !== state.exploreRequest) return;

    state.exploreList = meals;
    state.exploreVisible = PAGE_SIZE;

    showResultMeta(meals, { query, mode, category, area });
    renderExploreResults();
  } catch (error) {
    if (requestId !== state.exploreRequest) return;

    state.exploreList = [];
    if (title) title.textContent = 'Something went wrong';
    if (subtitle) subtitle.textContent = '';

    renderStatus(results, {
      title: 'Recipes could not be loaded',
      message: error.message,
      actions: [
        { label: 'Try again', action: 'explore-retry' },
        { label: 'Clear search', action: 'explore-clear', variant: 'btn-ghost' },
      ],
      icon: 'search',
    });
  } finally {
    if (results && requestId === state.exploreRequest) results.setAttribute('aria-busy', 'false');
  }
}

/**
 * Build the list of recipes for the current search.
 * Free-text search and category/cuisine filters are combined by intersecting
 * the ids returned by each endpoint, so the results are always real API data.
 */
async function buildResultPool({ query, mode, category, area }) {
  let pool = null;

  if (query) {
    pool = mode === 'ingredient' ? await apiFilter('i', query) : await apiSearchByName(query);
  }

  if (category) {
    const byCategory = await apiFilter('c', category);
    // The category is known from the request, so show it without waiting for lookups.
    byCategory.forEach((meal) => { meal.category = category; });
    pool = pool ? intersectPools(pool, byCategory) : byCategory;
  }

  if (area) {
    const byArea = await apiFilter('a', area);
    byArea.forEach((meal) => { meal.area = area; });
    pool = pool ? intersectPools(pool, byArea) : byArea;
  }

  if (!pool) pool = await loadFreshIdeas();
  return pool;
}

function intersectPools(pool, filterList) {
  const ids = new Set(filterList.map((meal) => meal.id));
  return pool
    .filter((meal) => ids.has(meal.id))
    .map((meal) => {
      const match = filterList.find((entry) => entry.id === meal.id);
      return {
        ...meal,
        category: meal.category || (match && match.category) || '',
        area: meal.area || (match && match.area) || '',
      };
    });
}

async function loadFreshIdeas(count = 6) {
  const results = await Promise.allSettled(Array.from({ length: count }, () => apiRandom()));
  const meals = [];

  results.forEach((result) => {
    if (result.status !== 'fulfilled' || !result.value) return;
    const summary = summaryFromDetail(result.value);
    if (summary && !meals.some((meal) => meal.id === summary.id)) meals.push(summary);
  });

  if (!meals.length) {
    throw new ApiError('We could not reach TheMealDB just now. Please check your connection and try again.');
  }

  return meals;
}

function showResultMeta(meals, { query, mode, category, area }) {
  const title = $('#explore-title');
  const subtitle = $('#explore-sub');
  if (!title || !subtitle) return;

  const count = meals.length;
  const countText = `${count} ${plural(count, 'recipe', 'recipes')} found`;

  if (query) {
    title.textContent = mode === 'ingredient' ? `Recipes with "${query}"` : `Results for "${query}"`;
    const extras = [category, area].filter(Boolean);
    subtitle.textContent = count ? `${countText}${extras.length ? ` — ${extras.join(' · ')}` : ''}` : '';
    return;
  }

  if (category && area) {
    title.textContent = `${area} ${category}`;
    subtitle.textContent = count ? countText : '';
    return;
  }

  if (category) {
    title.textContent = `${category} recipes`;
    subtitle.textContent = count ? countText : '';
    return;
  }

  if (area) {
    title.textContent = `${area} recipes`;
    subtitle.textContent = count ? countText : '';
    return;
  }

  title.textContent = 'Fresh ideas';
  subtitle.textContent = 'A random handful of recipes from TheMealDB. Search by name or ingredient, or pick a category or cuisine.';
}

function renderExploreResults() {
  const results = $('#explore-results');
  const loadMoreButton = $('#load-more');
  const meals = state.exploreList;

  if (!meals.length) {
    renderStatus(results, {
      title: 'No recipes found',
      message: querySummary() || 'Try a different recipe name, search by a single ingredient such as "garlic", or browse the categories instead.',
      actions: [
        { label: 'Clear search', action: 'explore-clear' },
        { label: 'Browse categories', href: '#categories', variant: 'btn-outline' },
        { label: 'Surprise Me!', action: 'surprise', variant: 'btn-ghost' },
      ],
      icon: 'search',
    });
    if (loadMoreButton) loadMoreButton.hidden = true;
    return;
  }

  const visible = meals.slice(0, state.exploreVisible);
  renderCards(results, visible);
  updateLoadMoreButton(loadMoreButton, meals.length, state.exploreVisible);
  enrichMeals(visible);
}

function querySummary() {
  const query = text($('#explore-search') ? $('#explore-search').value : '');
  if (!query) return '';
  const mode = $('#search-mode') && $('#search-mode').value === 'ingredient';
  return mode
    ? `No recipes using "${query}" were found. Try a simpler ingredient, or clear the category and cuisine filters.`
    : `No recipes matching "${query}" were found. Check the spelling, or try searching by a main ingredient instead.`;
}

function updateLoadMoreButton(button, total, shown) {
  if (!button) return;
  const remaining = Math.max(total - shown, 0);
  button.hidden = remaining === 0;
  button.textContent = `Load more recipes (${remaining} left)`;
}

function loadMoreExplore() {
  const start = state.exploreVisible;
  const next = Math.min(start + PAGE_SIZE, state.exploreList.length);
  if (next <= start) return;

  state.exploreVisible = next;
  const slice = state.exploreList.slice(start, next);
  appendCards($('#explore-results'), slice);
  updateLoadMoreButton($('#load-more'), state.exploreList.length, state.exploreVisible);
  enrichMeals(slice);
}

/* -----------------------------------------------------------------------------
   8b. Live search suggestions
   -------------------------------------------------------------------------- */
function closeSuggestions() {
  window.clearTimeout(suggestionTimer);
  suggestionTimer = null;
  suggestionRequest += 1;
  suggestionItems = [];
  suggestionActive = -1;

  const list = $('#search-suggestions');
  const input = $('#explore-search');
  if (list) {
    list.hidden = true;
    list.innerHTML = '';
  }
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
}

function scheduleSuggestions() {
  const input = $('#explore-search');
  const mode = $('#search-mode');
  if (!input) return;

  window.clearTimeout(suggestionTimer);
  const query = text(input.value);

  if ((mode && mode.value === 'ingredient') || query.length < 2) {
    closeSuggestions();
    return;
  }

  suggestionTimer = window.setTimeout(() => loadSuggestions(query), 300);
}

async function loadSuggestions(query) {
  const input = $('#explore-search');
  const mode = $('#search-mode');
  if (!input || !mode || mode.value === 'ingredient') return;
  if (text(input.value) !== query) return;

  const requestId = ++suggestionRequest;
  let meals;

  if (suggestionCache.has(query)) {
    meals = suggestionCache.get(query);
  } else {
    try {
      meals = await apiSearchByName(query);
    } catch (error) {
      if (requestId === suggestionRequest) closeSuggestions();
      return;
    }
    if (requestId !== suggestionRequest) return;
    suggestionCache.set(query, meals);
    if (suggestionCache.size > 40) {
      suggestionCache.delete(suggestionCache.keys().next().value);
    }
  }

  if (requestId !== suggestionRequest) return;
  if (text(input.value) !== query) return;

  const names = [];
  meals.forEach((meal) => {
    if (meal.name && !names.includes(meal.name)) names.push(meal.name);
  });

  suggestionItems = names.slice(0, 6);
  suggestionActive = -1;
  renderSuggestions(query);
}

function renderSuggestions(query) {
  const list = $('#search-suggestions');
  const input = $('#explore-search');
  if (!list || !input) return;

  if (!suggestionItems.length) {
    list.innerHTML = `<li class="suggestion-empty" role="presentation">No recipe names match “${escapeHtml(query)}”.</li>`;
  } else {
    list.innerHTML = suggestionItems.map((name, index) => `
      <li class="suggestion" id="suggestion-${index}" role="option" aria-selected="false" data-suggestion="${escapeHtml(name)}">${escapeHtml(name)}</li>`).join('');
  }

  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function applySuggestion(name) {
  const input = $('#explore-search');
  if (!input || !name) return;
  input.value = name;
  closeSuggestions();
  runExploreSearch();
}

function moveSuggestion(delta) {
  if (!suggestionItems.length) return;
  if (suggestionActive < 0) {
    suggestionActive = delta > 0 ? 0 : suggestionItems.length - 1;
  } else {
    suggestionActive = (suggestionActive + delta + suggestionItems.length) % suggestionItems.length;
  }

  const list = $('#search-suggestions');
  const input = $('#explore-search');
  if (!list || !input) return;

  $$('.suggestion', list).forEach((option, index) => {
    const active = index === suggestionActive;
    option.classList.toggle('is-active', active);
    option.setAttribute('aria-selected', String(active));
  });

  const activeOption = $(`#suggestion-${suggestionActive}`);
  if (activeOption) {
    input.setAttribute('aria-activedescendant', activeOption.id);
    activeOption.scrollIntoView({ block: 'nearest' });
  }
}

function handleSuggestionKeys(event) {
  const list = $('#search-suggestions');
  if (!list || list.hidden) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveSuggestion(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveSuggestion(-1);
  } else if (event.key === 'Enter') {
    if (suggestionActive >= 0 && suggestionItems[suggestionActive]) {
      event.preventDefault();
      applySuggestion(suggestionItems[suggestionActive]);
    } else {
      closeSuggestions();
    }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeSuggestions();
  }
}

/* -----------------------------------------------------------------------------
   9. Categories view
   -------------------------------------------------------------------------- */
async function initCategories() {
  resetCategoryView();
  await loadReferenceData();
  renderCategoryDirectory();
}

function renderCategoryDirectory() {
  const grid = $('#categories-grid');
  if (!grid) return;

  if (!state.categories.length) {
    renderStatus(grid, {
      title: 'Categories are unavailable',
      message: 'We could not load the category list from TheMealDB. Please check your connection and try again.',
      actions: [{ label: 'Try again', action: 'categories-retry' }],
    });
    return;
  }

  grid.innerHTML = state.categories.map(categoryCardMarkup).join('');
}

function resetCategoryView() {
  state.categoryView = null;
  const results = $('#category-results');
  const directory = $('#categories-directory');
  if (results) results.hidden = true;
  if (directory) directory.hidden = false;
}

async function openCategory(name) {
  const view = { name, list: [], visible: PAGE_SIZE };
  state.categoryView = view;

  const directory = $('#categories-directory');
  const results = $('#category-results');
  const grid = $('#category-results-grid');
  const title = $('#category-results-title');
  const loadMoreButton = $('#category-load-more');

  if (directory) directory.hidden = true;
  if (results) results.hidden = false;
  if (title) title.textContent = `${name} recipes`;
  if (grid) grid.innerHTML = skeletonMarkup(8);
  if (loadMoreButton) loadMoreButton.hidden = true;

  try {
    const meals = await apiFilter('c', name);
    if (state.categoryView !== view) return;

    meals.forEach((meal) => { meal.category = name; });
    view.list = meals;
    if (!meals.length) {
      renderStatus(grid, {
        title: 'No recipes in this category',
        message: 'TheMealDB did not return any recipes for this category.',
        actions: [{ label: 'Back to categories', action: 'back-categories' }],
      });
      return;
    }

    renderCategoryResults();
  } catch (error) {
    if (state.categoryView !== view) return;
    renderStatus(grid, {
      title: 'Recipes could not be loaded',
      message: error.message,
      actions: [{ label: 'Try again', action: 'retry-category' }],
      icon: 'search',
    });
  }
}

function renderCategoryResults() {
  const view = state.categoryView;
  if (!view) return;
  const grid = $('#category-results-grid');
  const visible = view.list.slice(0, view.visible);
  renderCards(grid, visible);
  updateLoadMoreButton($('#category-load-more'), view.list.length, view.visible);
  enrichMeals(visible);
}

function loadMoreCategory() {
  const view = state.categoryView;
  if (!view) return;

  const start = view.visible;
  const next = Math.min(start + PAGE_SIZE, view.list.length);
  if (next <= start) return;

  view.visible = next;
  const slice = view.list.slice(start, next);
  appendCards($('#category-results-grid'), slice);
  updateLoadMoreButton($('#category-load-more'), view.list.length, view.visible);
  enrichMeals(slice);
}

/* -----------------------------------------------------------------------------
   10. Favorites view
   -------------------------------------------------------------------------- */
function renderFavorites() {
  const grid = $('#favorites-grid');
  const empty = $('#favorites-empty');
  updateFavoriteUI();

  if (!state.favorites.length) {
    if (grid) grid.innerHTML = '';
    if (empty) {
      empty.hidden = false;
      renderStatus(empty, {
        title: 'No favorites yet',
        message: 'Tap “Save” on any recipe card to keep it in your Supabase favorites.',
        actions: [
          { label: 'Explore recipes', href: '#explore' },
          { label: 'Surprise Me!', action: 'surprise', variant: 'btn-outline' },
        ],
        icon: 'heart',
      });
    }
    return;
  }

  if (empty) empty.hidden = true;
  renderCards(grid, state.favorites);
}

/* -----------------------------------------------------------------------------
   11. Recipe detail modal
   -------------------------------------------------------------------------- */
function extractIngredients(raw) {
  const ingredients = [];
  for (let index = 1; index <= 20; index += 1) {
    const name = text(raw[`strIngredient${index}`]);
    const measure = text(raw[`strMeasure${index}`]);
    if (name) ingredients.push({ name, measure: measure || 'to taste' });
  }
  return ingredients;
}

function extractSteps(raw) {
  const instructions = text(raw.strInstructions);
  if (!instructions) return [];

  return instructions
    .split(/\r?\n/)
    .map((line) => line.replace(/^step\s*\d+\s*[:.)-]?\s*/i, '').trim())
    .filter((line) => line.length > 1);
}

function modalMarkup(raw) {
  const meal = summaryFromDetail(raw);
  if (!meal) return modalErrorMarkup('This recipe does not include enough data to display.');

  const saved = isFavorite(meal.id);
  const ingredients = extractIngredients(raw);
  const steps = extractSteps(raw);
  const source = text(raw.strSource);
  const youtube = text(raw.strYoutube);
  const hasSource = isHttpUrl(source);
  const hasYouTube = isHttpUrl(youtube);

  const ingredientsHtml = ingredients.length
    ? `<ul class="ingredient-list">${ingredients.map((item) => `
        <li><span>${escapeHtml(item.name)}</span><strong>${escapeHtml(item.measure)}</strong></li>`).join('')}
      </ul>`
    : '<p class="muted">Ingredient details are not available for this recipe.</p>';

  const stepsHtml = steps.length
    ? `<ol class="step-list">${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`
    : '<p class="muted">This recipe does not include written instructions in the API.</p>';

  return `
    <div class="modal-hero">
      <img class="modal-image" src="${escapeHtml(meal.thumb || FALLBACK_IMAGE)}" alt="${escapeHtml(meal.name)}" />
      <div class="modal-hero-text">
        <div class="chip-row">
          <span class="chip chip-light">${escapeHtml(meal.category || 'Category not listed')}</span>
          <span class="chip chip-light">${escapeHtml(meal.area || 'Cuisine not listed')}</span>
        </div>
        <h2 id="modal-title">${escapeHtml(meal.name)}</h2>
      </div>
    </div>

    <div class="modal-content">
      <div class="modal-actions">
        <button class="btn btn-primary${saved ? ' is-saved' : ''}" type="button" data-save="${escapeHtml(meal.id)}" data-meal-name="${escapeHtml(meal.name)}"
          aria-pressed="${saved}" aria-label="${saved ? 'Remove' : 'Add'} ${escapeHtml(meal.name)} ${saved ? 'from' : 'to'} favorites">
          <svg class="icon" aria-hidden="true"><use href="#icon-heart" /></svg>
          <span data-save-label>${saved ? 'Saved' : 'Save'}</span>
        </button>
        <button class="btn btn-outline" type="button" data-action="add-to-shopping" data-value="${escapeHtml(meal.id)}">
          <svg class="icon" aria-hidden="true"><use href="#icon-basket" /></svg>
          Add ingredients
        </button>
        ${hasYouTube ? `
          <a class="btn btn-outline" href="${escapeHtml(youtube)}" target="_blank" rel="noopener noreferrer">
            Watch on YouTube
          </a>` : ''}
      </div>

      <div class="source-block${hasSource ? '' : ' source-missing'}">
        <div>
          <p class="source-label">Original recipe</p>
          <p class="source-text">${hasSource
            ? 'Source provided by the recipe publisher through TheMealDB.'
            : 'TheMealDB does not provide a source link for this recipe.'}</p>
        </div>
        ${hasSource
          ? `<a class="btn btn-primary" href="${escapeHtml(source)}" target="_blank" rel="noopener noreferrer nofollow">View Original Recipe</a>`
          : '<span class="source-unavailable">Original source unavailable</span>'}
      </div>

      <div class="modal-grid">
        <section>
          <h3>Ingredients</h3>
          ${ingredientsHtml}
        </section>
        <section>
          <h3>Instructions</h3>
          ${stepsHtml}
        </section>
      </div>
    </div>`;
}

function modalErrorMarkup(message, id = '') {
  return `
    <div class="modal-status">
      <h2 id="modal-title">Recipe unavailable</h2>
      <p>${escapeHtml(message)}</p>
      <button class="btn btn-outline" type="button" data-action="retry-modal"${id ? ` data-value="${escapeHtml(id)}"` : ''}>Try again</button>
    </div>`;
}

function modalSkeletonMarkup() {
  return `
    <div class="modal-hero sk" aria-hidden="true"></div>
    <div class="modal-loading">
      <h2 id="modal-title" class="sr-only">Loading recipe</h2>
      <div class="sk sk-line" style="width:38%;height:18px"></div>
      <div class="sk sk-line" style="width:100%;height:56px;border-radius:999px"></div>
      <div class="sk sk-line" style="width:100%;height:120px;border-radius:18px"></div>
      <div class="sk sk-line" style="width:86%"></div>
      <div class="sk sk-line" style="width:70%"></div>
    </div>`;
}

function openRecipeModal(id) {
  const modal = $('#recipe-modal');
  const body = $('#modal-body');
  if (!modal || !body) return;

  state.modalReturnFocus = document.activeElement;
  const requestId = ++state.modalRequest;

  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  body.innerHTML = modalSkeletonMarkup();

  const closeButton = $('#modal-close');
  if (closeButton) closeButton.focus({ preventScroll: true });

  loadModalRecipe(id, requestId);
}

async function loadModalRecipe(id, requestId) {
  const body = $('#modal-body');
  try {
    const detail = await apiLookup(id);
    if (requestId !== state.modalRequest) return;
    if (!detail) {
      throw new ApiError('This recipe could not be found. It may no longer be available in TheMealDB.');
    }
    body.innerHTML = modalMarkup(detail);
    recordRecentlyViewed(detail);
  } catch (error) {
    if (requestId !== state.modalRequest) return;
    body.innerHTML = modalErrorMarkup(error.message, id);
  }
}

/** Retry a failed recipe lookup without closing the modal. */
function retryModal(id) {
  const body = $('#modal-body');
  if (!body || !id) return;
  const requestId = ++state.modalRequest;
  body.innerHTML = modalSkeletonMarkup();
  loadModalRecipe(id, requestId);
}

function closeRecipeModal() {
  const modal = $('#recipe-modal');
  if (!modal || !modal.classList.contains('is-open')) return;

  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  state.modalRequest += 1; // cancel any in-flight detail render

  const target = state.modalReturnFocus;
  state.modalReturnFocus = null;
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

/** Keep keyboard focus inside the open modal. */
function trapModalFocus(event) {
  if (event.key !== 'Tab') return;
  const modal = $('#recipe-modal');
  if (!modal || !modal.classList.contains('is-open')) return;

  const focusable = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', modal)
    .filter((element) => element.offsetParent !== null);

  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* -----------------------------------------------------------------------------
   12. Events & initialisation
   -------------------------------------------------------------------------- */
function updateHeaderState() {
  const header = $('#site-header');
  if (header) header.classList.toggle('is-scrolled', window.scrollY > 8);
}

function openMobileNav() {
  const nav = $('#primary-nav');
  const toggle = $('#nav-toggle');
  if (!nav || !toggle) return;
  nav.classList.add('is-open');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-label', 'Close menu');
}

function closeMobileNav() {
  const nav = $('#primary-nav');
  const toggle = $('#nav-toggle');
  if (!nav || !toggle) return;
  nav.classList.remove('is-open');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Open menu');
}

function handleAction(action, value) {
  switch (action) {
    case 'surprise':
      surpriseMe();
      break;
    case 'explore-retry':
      runExploreSearch();
      break;
    case 'explore-clear':
      clearExploreForm();
      runExploreSearch();
      break;
    case 'refresh-featured':
      loadHomePicks();
      break;
    case 'refresh-categories':
      loadHomeCategories(true);
      break;
    case 'refresh-filipino':
      loadFilipinoPicks();
      break;
    case 'explore-area':
      if (value === FILIPINO_AREA) exploreAllFilipino();
      else goExploreWithArea(value);
      break;
    case 'explore-all':
      if (value === FILIPINO_AREA) exploreAllFilipino();
      else goExploreWithArea(value);
      break;
    case 'categories-retry':
      loadReferenceData(true).then(renderCategoryDirectory);
      break;
    case 'explore-category':
      goExploreWithCategory(value);
      break;
    case 'back-categories':
      resetCategoryView();
      break;
    case 'retry-category':
      if (state.categoryView) openCategory(state.categoryView.name);
      break;
    case 'retry-modal':
      retryModal(value);
      break;
    case 'add-to-shopping':
      addRecipeToShopping(value);
      break;
    case 'shopping-add-favorites':
      addFavoritesToShopping();
      break;
    case 'shopping-clear-checked':
      clearCheckedShopping();
      break;
    case 'shopping-clear':
      clearShoppingList();
      break;
    case 'clear-recent':
      clearRecentlyViewed();
      break;
    default:
      break;
  }
}

async function surpriseMe() {
  const buttons = $$('[data-action="surprise"]');
  buttons.forEach((button) => {
    button.disabled = true;
    button.classList.add('is-busy');
  });

  try {
    const meal = await apiRandom();
    if (!meal || !meal.idMeal) {
      throw new ApiError('TheMealDB did not return a recipe. Please try again.');
    }
    openRecipeModal(String(meal.idMeal));
  } catch (error) {
    showToast(error.message, { type: 'error', duration: 5000 });
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      button.classList.remove('is-busy');
    });
  }
}

function handleDocumentClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const saveButton = target.closest('[data-save]');
  if (saveButton) {
    event.preventDefault();
    toggleFavorite(saveButton.dataset.save);
    return;
  }

  const openButton = target.closest('[data-open]');
  if (openButton) {
    event.preventDefault();
    openRecipeModal(openButton.dataset.open);
    return;
  }

  const removeShoppingItemButton = target.closest('[data-shopping-remove]');
  if (removeShoppingItemButton) {
    event.preventDefault();
    removeShoppingItem(removeShoppingItemButton.dataset.shoppingRemove);
    return;
  }

  const actionButton = target.closest('[data-action]');
  if (actionButton) {
    event.preventDefault();
    handleAction(actionButton.dataset.action, actionButton.dataset.value);
    return;
  }

  if (target.closest('[data-close-modal]')) closeRecipeModal();
}

function handleDocumentChange(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const toggle = target.closest('[data-shopping-toggle]');

  if (toggle) {
    toggleShoppingItem(
      toggle.dataset.shoppingToggle,
      toggle.checked
    );
  }
}

function handleOutsideSuggestionClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !target.closest('.input-wrap')) closeSuggestions();
}

function handleKeydown(event) {
  if (event.key !== 'Escape') return;
  const modal = $('#recipe-modal');
  if (modal && modal.classList.contains('is-open')) {
    closeRecipeModal();
    return;
  }
  closeMobileNav();
}

/** Swap broken API images for the local placeholder. */
function handleImageError(event) {
  const target = event.target;
  if (!(target instanceof HTMLImageElement)) return;
  if (target.dataset.fallbackApplied === 'true') return;
  target.dataset.fallbackApplied = 'true';
  target.src = FALLBACK_IMAGE;
}

function bindEvents() {
  const themeToggle = $('#theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });
  }

  const heroForm = $('#hero-form');
  if (heroForm) {
    heroForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('#hero-search');
      const query = text(input ? input.value : '');

      clearExploreForm();
      const exploreInput = $('#explore-search');
      if (exploreInput) exploreInput.value = query;

      goToExplore();
    });
  }

  const exploreForm = $('#explore-form');
  if (exploreForm) {
    exploreForm.addEventListener('submit', (event) => {
      event.preventDefault();
      runExploreSearch();
    });

    exploreForm.addEventListener('change', (event) => {
      if (event.target instanceof HTMLSelectElement) runExploreSearch();
    });
  }

  const clearButton = $('#clear-filters');
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      clearExploreForm();
      runExploreSearch();
    });
  }

  const loadMoreButton = $('#load-more');
  if (loadMoreButton) loadMoreButton.addEventListener('click', loadMoreExplore);

  const categoryLoadMore = $('#category-load-more');
  if (categoryLoadMore) categoryLoadMore.addEventListener('click', loadMoreCategory);

  const backButton = $('#back-to-categories');
  if (backButton) backButton.addEventListener('click', resetCategoryView);

  const shuffleButton = $('#featured-refresh');
  if (shuffleButton) shuffleButton.addEventListener('click', loadHomePicks);

  const navToggle = $('#nav-toggle');
  if (navToggle) {
    navToggle.addEventListener('click', () => {
      const nav = $('#primary-nav');
      if (nav && nav.classList.contains('is-open')) closeMobileNav();
      else openMobileNav();
    });
  }

  const navSearch = $('#nav-search-btn');
  if (navSearch) {
    navSearch.addEventListener('click', () => {
      goToExplore();
      window.requestAnimationFrame(() => {
        const input = $('#explore-search');
        if (input) input.focus({ preventScroll: true });
      });
    });
  }

  const navShopping = $('#nav-shopping-btn');
  if (navShopping) {
    navShopping.addEventListener('click', () => {
      if (location.hash === '#shopping') handleRoute();
      else location.hash = '#shopping';
    });
  }

  const exploreInput = $('#explore-search');
  const suggestionList = $('#search-suggestions');
  if (exploreInput) {
    exploreInput.addEventListener('input', scheduleSuggestions);
    exploreInput.addEventListener('keydown', handleSuggestionKeys);
    exploreInput.addEventListener('blur', () => window.setTimeout(closeSuggestions, 120));
  }
  if (suggestionList) {
    suggestionList.addEventListener('mousedown', (event) => event.preventDefault());
    suggestionList.addEventListener('click', (event) => {
      const option = event.target instanceof Element ? event.target.closest('[data-suggestion]') : null;
      if (option) applySuggestion(option.dataset.suggestion);
    });
  }

  $$('.nav-link').forEach((link) => {
    link.addEventListener('click', () => {
      closeMobileNav();
      // Clicking the link for the page you are already on should still work.
      if (link.dataset.nav === currentRoute() && location.hash === `#${currentRoute()}`) {
        handleRoute();
      }
    });
  });

  const modalClose = $('#modal-close');
  if (modalClose) modalClose.addEventListener('click', closeRecipeModal);

  const modal = $('#recipe-modal');
  if (modal) modal.addEventListener('keydown', trapModalFocus);

  window.addEventListener('hashchange', handleRoute);
  window.addEventListener('scroll', updateHeaderState, { passive: true });
  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('click', handleOutsideSuggestionClick);
  document.addEventListener('change', handleDocumentChange);
  document.addEventListener('keydown', handleKeydown);
  document.addEventListener('error', handleImageError, true);
}

async function init() {
  state.recent = loadRecent();
  initTheme();

  updateFavoriteUI();
  updateShoppingUI();
  renderRecent();
  bindEvents();

  const year = $('#year');
  if (year) {
    year.textContent = String(new Date().getFullYear());
  }

  loadReferenceData();
  handleRoute();
  updateHeaderState();

  try {
    await initializeSupabase();

    await Promise.all([
      loadFavoritesFromSupabase(),
      loadShoppingFromSupabase(),
    ]);

    updateFavoriteUI();
    updateShoppingUI();

    if (currentRoute() === 'favorites') {
      renderFavorites();
    }

    if (currentRoute() === 'shopping') {
      renderShopping();
    }

    console.log('Supabase connected successfully.');
  } catch (error) {
    console.error('Supabase initialization failed:', error);

    showToast(
      'Could not connect to Supabase. Check your connection and refresh the page.',
      { type: 'error', duration: 5000 }
    );
  }
}

init();
