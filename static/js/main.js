(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* -----------------------------------------------------------------------
     Hero title
     Keeps the title centered in the part of the hero video that is still
     visible while scrolling, but never lets it get closer than `gap` to the
     video's bottom edge — from then on it scrolls away with the video.
     ----------------------------------------------------------------------- */
  function initHeroTitle() {
    const hero = $('.hero');
    const title = $('.hero-title');
    if (!hero || !title) return;

    let heroH = 0;
    let titleH = 0;
    let gap = 0;
    let queued = false;

    const measure = () => {
      heroH = hero.offsetHeight;
      titleH = title.offsetHeight;
      gap = Math.min(96, Math.max(40, window.innerHeight * 0.09));
      update();
    };

    const update = () => {
      queued = false;
      const scroll = Math.min(Math.max(window.scrollY, 0), heroH);
      const heroBottom = heroH - scroll;                       // in viewport coordinates
      const visible = Math.min(window.innerHeight, heroBottom);
      const center = Math.min(visible / 2, heroBottom - gap - titleH / 2);
      // Offset from the CSS default position (vertically centered in the hero).
      const dy = scroll + center - heroH / 2;
      title.style.transform = `translate3d(0, calc(-50% + ${dy.toFixed(1)}px), 0)`;
    };

    const onScroll = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(update);
      }
    };

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);

    // The title is hidden (CSS) until Open Sans is ready, so it never flashes in
    // the wider fallback font. If the font is slow or blocked, show it anyway.
    const root = document.documentElement;
    const reveal = () => {
      if (root.classList.contains('fonts-ready')) return;
      root.classList.add('fonts-ready');
      measure();
    };
    if (document.fonts && document.fonts.load) {
      document.fonts.load('700 1em "Open Sans"').then(reveal, reveal);
      setTimeout(reveal, 2500);
      if (document.fonts.ready) document.fonts.ready.then(measure);
    } else {
      reveal();
    }
  }

  /* -----------------------------------------------------------------------
     Videos
     Autoplaying clips load lazily and only play while on screen. Front/top
     view pairs are kept in sync and restart together.
     ----------------------------------------------------------------------- */
  const MAX_DRIFT = 0.15;   // seconds a pair may drift apart while playing before it is re-aligned
  // Groups whose autoplay the browser refused; any tap/click/key press restarts them.
  const blockedGroups = new Set();
  const resumeBlocked = () => {
    blockedGroups.forEach((g) => g.unblock());
    blockedGroups.clear();
  };
  ['pointerdown', 'touchend', 'keydown'].forEach((type) =>
    document.addEventListener(type, resumeBlocked, { capture: true, passive: true }));

  // True when the clip has at least a second (or the rest of the clip) buffered ahead.
  const hasDataAhead = (v) => {
    const need = Math.min(v.currentTime + 1, (v.duration || Infinity) - 0.05);
    for (let k = 0; k < v.buffered.length; k++) {
      if (v.buffered.start(k) <= v.currentTime + 0.05 && v.buffered.end(k) >= need) return true;
    }
    return false;
  };

  const bufferedEnd = (v) => (v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0);

  class VideoGroup {
    constructor(videos, synced) {
      this.videos = videos;
      this.synced = synced && videos.length > 1;
      this.inView = false;
      this.enabled = true;
      this.blocked = false;
      this.timer = null;
      this.lastTimes = null;
      this.lastTickAt = 0;
      this.lastBuffered = null;
      this.state = 'holding';   // synced pairs: 'holding' (getting ready) or 'playing'

      videos.forEach((v) => {
        v.muted = true;
        v.playsInline = true;
        v.loop = !this.synced;
        v.tabIndex = -1;          // decorative loops: not a keyboard stop (Firefox would make them one)
      });

      if (this.synced) {
        // Loop by restarting together when the lead clip ends.
        videos[0].addEventListener('ended', () => { if (!this.blocked) this.restart(); });
        // React to buffering at once instead of waiting for the next tick, and
        // start a holding pair as soon as its seeks have landed.
        videos.forEach((v) => {
          v.addEventListener('waiting', () => {
            if (this.state === 'playing' && this.shouldPlay && !this.blocked) this.tick();
          });
          v.addEventListener('seeked', () => {
            if (this.state === 'holding' && this.shouldPlay && !this.blocked) this.tick();
          });
        });
      }
    }

    // The browser refused autoplay (e.g. iOS Low Power Mode or a site setting): show
    // native controls so a clip can be started by hand; the next tap anywhere on the
    // page (a user gesture) restarts everything via unblock().
    block() {
      this.blocked = true;
      blockedGroups.add(this);
      this.stopTicking();
      this.videos.forEach((v) => {
        if (v.classList.contains('hero-video')) {   // background video: just hold still
          v.autoplay = false;
          v.preload = 'none';
          v.pause();
          return;
        }
        if (v.closest('[data-zoom]')) return;        // plays in the lightbox instead
        v.preload = 'metadata';
        v.controls = true;
        v.loop = true;
        v.tabIndex = 0;
      });
    }

    unblock() {
      this.blocked = false;
      this.state = 'holding';
      this.videos.forEach((v) => {
        if (v.classList.contains('hero-video')) v.autoplay = true;
        v.controls = false;
        v.loop = !this.synced;
        v.tabIndex = -1;
        if (this.shouldPlay) this.play(v);   // inside the gesture, so the browser allows it
      });
      this.update();
    }

    load() {
      this.videos.forEach((v) => {
        if (v.dataset.src && !v.getAttribute('src')) {
          v.preload = this.blocked ? 'metadata' : 'auto';   // blocked: fetch only when started
          v.src = v.dataset.src;
        }
      });
    }

    get shouldPlay() {
      return this.inView && this.enabled && !document.hidden;
    }

    play(v) {
      const p = v.play();
      if (p) {
        p.catch((err) => {
          if (err && err.name === 'NotAllowedError' && !this.blocked) this.block();
        });
      }
    }

    update() {
      if (!this.shouldPlay) {
        this.stopTicking();
        this.state = 'holding';   // come back in step
        this.videos.forEach((v) => v.pause());
        return;
      }
      this.load();
      if (this.blocked) return;   // the viewer starts these by hand
      if (this.synced) {
        this.tick();
        if (!this.timer) this.timer = setInterval(() => this.tick(), 250);
      } else {
        this.videos.forEach((v) => { if (v.paused) this.play(v); });
      }
    }

    stopTicking() {
      clearInterval(this.timer);
      this.timer = null;
      this.lastTimes = null;
    }

    // Keeps a synced pair together by polling rather than trusting media events
    // or readyState, which differ between browsers (WebKit even reports a playing
    // clip as HAVE_CURRENT_DATA, and can leave one frozen with data buffered).
    //  - playing: if a clip stalls (no frame, seeking, or its time stopped
    //    moving), switch to holding; otherwise nudge back any small drift.
    //  - holding: keep every clip paused while it downloads; one whose buffer
    //    is not growing is played instead so it fetches (iOS only buffers while
    //    playing). Once all have data buffered ahead, line them up on the one
    //    behind and start them together.
    tick() {
      if (!this.shouldPlay || this.blocked) {
        this.update();
        return;
      }
      const vids = this.videos;
      if (vids[0].ended) {
        this.restart();
        return;
      }
      const active = vids.filter((v) => !v.ended);
      const times = vids.map((v) => v.currentTime);
      const buffered = vids.map(bufferedEnd);
      // Only compare against a sample taken a real interval ago; an event-driven
      // tick right after the timer tick would otherwise read as a stall.
      const now = performance.now();
      const spaced = now - this.lastTickAt >= 150;
      const last = spaced ? this.lastTimes : null;
      const lastBuffered = spaced ? this.lastBuffered : null;
      if (spaced || this.lastTimes === null) {
        this.lastTimes = times;
        this.lastBuffered = buffered;
        this.lastTickAt = now;
      }

      if (this.state === 'playing') {
        const stalled = vids.some((v, i) => !v.ended && !v.paused && (
          v.readyState < 2 || v.seeking || (last !== null && Math.abs(times[i] - last[i]) < 0.01)
        ));
        if (!stalled) {
          const behind = Math.min(...active.map((v) => v.currentTime));
          if (active.some((v) => v.currentTime - behind > MAX_DRIFT)) {
            this.state = 'holding';                  // re-align through a clean restart
          } else {
            active.forEach((v) => { if (v.paused) this.play(v); });
            return;
          }
        }
        this.state = 'holding';
      }

      let ready = true;
      vids.forEach((v, i) => {
        if (v.ended) return;
        if (v.seeking) {
          ready = false;
        } else if (v.readyState >= 2 && hasDataAhead(v)) {
          if (!v.paused) v.pause();
        } else {
          ready = false;
          if (lastBuffered === null) return;         // decide on the next timed tick
          const growing = buffered[i] > lastBuffered[i] + 0.01;
          if (growing && !v.paused) v.pause();
          else if (!growing && v.paused) this.play(v);
        }
      });
      if (!ready) return;

      // Moving the clips that are ahead back only lands in buffered data.
      const behind = Math.min(...active.map((v) => v.currentTime));
      if (active.some((v) => v.currentTime - behind > 0.04)) {
        active.forEach((v) => { if (v.currentTime - behind > 0.04) v.currentTime = behind; });
        return;                                      // start once those seeks are done
      }
      active.forEach((v) => this.play(v));
      this.state = 'playing';
      this.lastTimes = null;                         // don't mistake the start-up for a stall
    }

    restart() {
      this.state = 'holding';
      this.lastTimes = null;
      this.lastBuffered = null;
      this.lastTickAt = 0;
      this.videos.forEach((v) => {
        v.pause();                 // so no clip runs ahead while the others seek
        if (v.readyState > 0) v.currentTime = 0;
      });
      this.update();
    }
  }

  const groups = [];

  function initVideos() {
    const anchors = new Map();
    const addGroup = (group, anchor) => {
      groups.push(group);
      if (!anchors.has(anchor)) anchors.set(anchor, []);
      anchors.get(anchor).push(group);
    };

    $$('.pair[data-sync]').forEach((pair) => {
      const group = new VideoGroup($$('video', pair), true);
      pair.videoGroup = group;
      addGroup(group, pair.closest('.carousel') || pair);
    });

    $$('video[data-autoplay]').forEach((v) => {
      addGroup(new VideoGroup([v], false), v);
    });

    if (!('IntersectionObserver' in window)) {
      groups.forEach((g) => { g.inView = true; g.update(); });
      return;
    }

    // Start fetching a little before a clip scrolls into view...
    const preloader = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        anchors.get(e.target).forEach((g) => g.load());
        preloader.unobserve(e.target);
      });
    }, { rootMargin: '600px 0px' });

    // ...and only play while it is actually visible.
    const player = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        anchors.get(e.target).forEach((g) => {
          g.inView = e.isIntersecting;
          g.update();
        });
      });
    }, { threshold: 0.05 });

    anchors.forEach((_, anchor) => {
      preloader.observe(anchor);
      player.observe(anchor);
    });

    document.addEventListener('visibilitychange', () => groups.forEach((g) => g.update()));
  }

  /* -----------------------------------------------------------------------
     Carousels (capsule pagination)
     ----------------------------------------------------------------------- */
  function initCarousels() {
    $$('.carousel').forEach((carousel) => {
      const viewport = $('.carousel-viewport', carousel);
      const track = $('.carousel-track', carousel);
      const slides = $$('.slide', carousel);
      const pills = $$('.pill', carousel);
      let index = 0;

      const groupOf = (slide) => {
        const pair = $('.pair', slide);
        return pair ? pair.videoGroup : null;
      };

      const fitHeight = () => {
        viewport.style.height = `${slides[index].offsetHeight}px`;
      };

      const go = (next, initial = false) => {
        next = Math.max(0, Math.min(slides.length - 1, next));
        if (next === index && !initial) return;
        index = next;

        track.style.transform = `translateX(${-100 * index}%)`;
        slides.forEach((slide, i) => {
          const active = i === index;
          slide.setAttribute('aria-hidden', String(!active));
          slide.inert = !active;
          const g = groupOf(slide);
          if (!g) return;
          g.enabled = active;
          if (active && !initial) g.restart();
          else g.update();
        });
        pills.forEach((pill, i) => {
          pill.setAttribute('aria-selected', String(i === index));
          pill.tabIndex = i === index ? 0 : -1;
        });
        fitHeight();
      };

      pills.forEach((pill, i) => {
        pill.addEventListener('click', () => go(i));
        pill.addEventListener('keydown', (e) => {
          const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          go(index + step);
          pills[index].focus();
        });
      });

      // Horizontal swipe on touch screens.
      let startX = null;
      let startY = null;
      viewport.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        startX = e.clientX;
        startY = e.clientY;
      });
      viewport.addEventListener('pointerup', (e) => {
        if (startX === null) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        startX = null;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(index + (dx < 0 ? 1 : -1));
      });
      viewport.addEventListener('pointercancel', () => { startX = null; });

      if ('ResizeObserver' in window) new ResizeObserver(fitHeight).observe(slides[0]);
      window.addEventListener('resize', fitHeight);

      go(0, true);
    });
  }

  /* -----------------------------------------------------------------------
     Overall framework: highlight the part of the figure a paragraph describes
     ----------------------------------------------------------------------- */
  function initFrameworkHighlight() {
    const stack = $('.fw-stack');
    const paras = $$('.fw-text [data-hl]');
    if (!stack || !paras.length) return;

    const layers = $$('img[data-layer]', stack).filter((img) => img.dataset.layer !== 'base');
    let hovered = null;
    let focused = null;
    let pinned = null;

    const render = () => {
      const current = hovered || focused || pinned;
      const key = current ? current.dataset.hl : null;
      layers.forEach((img) => img.classList.toggle('is-active', img.dataset.layer === key));
      paras.forEach((p) => p.classList.toggle('is-active', p === current));
    };

    // When the figure is pinned (narrow portrait screens), keep a keyboard-focused
    // paragraph from ending up underneath it.
    const figure = $('.fw-figure');
    const keepClearOfFigure = (p) => {
      if (!figure || getComputedStyle(figure).position !== 'sticky') return;
      const overlap = figure.getBoundingClientRect().bottom + 16 - p.getBoundingClientRect().top;
      if (overlap > 0) window.scrollBy(0, -overlap);
    };

    paras.forEach((p) => {
      // Real mouse hover only: touch screens emulate a hover that never ends.
      p.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hovered = p; render(); } });
      p.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hovered = null; render(); } });
      p.addEventListener('focus', () => {
        let keyboard = true;
        try { keyboard = p.matches(':focus-visible'); } catch (e) { /* older browsers */ }
        if (!keyboard) return;
        focused = p;
        render();
        requestAnimationFrame(() => keepClearOfFigure(p));
      });
      p.addEventListener('blur', () => { focused = null; render(); });
      p.addEventListener('click', () => { pinned = pinned === p ? null : p; render(); });
    });

    document.addEventListener('click', (e) => {
      if (pinned && !e.target.closest('.fw-text [data-hl], .fw-stack, .lightbox')) {
        pinned = null;
        render();
      }
    });
  }

  /* -----------------------------------------------------------------------
     Lightbox (click to enlarge)
     ----------------------------------------------------------------------- */
  function initLightbox() {
    const box = $('#lightbox');
    if (!box) return;
    const stage = $('.lightbox-stage', box);
    const closeBtn = $('.lightbox-close', box);
    let returnFocus = null;

    const contentFor = (el) => {
      const video = el.matches('video') ? el : $('video', el);
      if (video) {
        const v = document.createElement('video');
        v.src = video.currentSrc || video.dataset.src || '';
        v.muted = true;
        v.loop = true;
        v.autoplay = true;
        v.playsInline = true;
        v.controls = true;
        v.setAttribute('aria-label', video.getAttribute('aria-label') || 'Enlarged video');
        if (video.currentTime) v.currentTime = video.currentTime;
        return v;
      }
      // For the framework figure, enlarge whichever layer is showing.
      const img = el.matches('img') ? el : ($('img.is-active', el) || $('img', el));
      const out = new Image();
      out.src = img.currentSrc || img.src;
      out.alt = img.alt || ($('img', el) && $('img', el).alt) || '';
      // On touch screens too narrow to show the figure legibly, show it wider and let it pan.
      const ratio = (img.naturalWidth || img.width) / (img.naturalHeight || img.height || 1);
      const readable = ratio > 2.5 ? 1500 : 1000;        // px wide at which figure text is legible
      const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (touch && window.innerWidth < readable * 0.8) {
        out.classList.add('is-pannable');
        out.style.setProperty('--pan-width', `${readable}px`);
      }
      return out;
    };

    const open = (el) => {
      returnFocus = document.activeElement;
      const content = contentFor(el);
      stage.replaceChildren(content);
      // A pannable stage can take focus so the arrow keys scroll it.
      if (content.classList.contains('is-pannable')) stage.tabIndex = 0;
      else stage.removeAttribute('tabindex');
      box.hidden = false;
      stage.scrollLeft = 0;       // after un-hiding: a hidden element keeps its old offset
      stage.scrollTop = 0;
      document.documentElement.classList.add('no-scroll');
      closeBtn.focus({ preventScroll: true });
    };

    const close = () => {
      box.hidden = true;
      stage.replaceChildren();
      document.documentElement.classList.remove('no-scroll');
      if (returnFocus) returnFocus.focus({ preventScroll: true });
    };

    $$('[data-zoom]').forEach((el) => {
      el.addEventListener('click', () => open(el));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(el);
        }
      });
    });

    box.addEventListener('click', (e) => {
      if (e.target === box || e.target === stage) close();
    });
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {         // keep focus inside the dialog
        const focusable = [closeBtn, ...(stage.tabIndex === 0 ? [stage] : []), ...$$('video', stage)];
        const i = focusable.indexOf(document.activeElement);
        const next = (i + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
        e.preventDefault();
        focusable[next].focus();
      }
    });
  }

  /* -----------------------------------------------------------------------
     "Related Research" dropdown: close on outside click / Escape
     ----------------------------------------------------------------------- */
  function initRelated() {
    $$('details.related').forEach((d) => {
      document.addEventListener('click', (e) => { if (d.open && !d.contains(e.target)) d.open = false; });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && d.open) { d.open = false; $('summary', d).focus(); }
      });
      d.addEventListener('focusout', (e) => { if (e.relatedTarget && !d.contains(e.relatedTarget)) d.open = false; });
      // A click into the YouTube player (an iframe) blurs the page: close the menu then too.
      window.addEventListener('blur', () => { if (d.open) d.open = false; });
      // Browsers don't all report that blur, so also close when the pointer moves onto the player.
      $$('.intro-video').forEach((v) => v.addEventListener('pointerenter', () => { if (d.open) d.open = false; }));
    });
  }

  /* -----------------------------------------------------------------------
     Link buttons whose URL is not filled in yet (href="") are shown but inert
     ----------------------------------------------------------------------- */
  function initPlaceholderLinks() {
    $$('.btn-pill[href=""]').forEach((a) => {
      a.removeAttribute('href');           // no href: not focusable, not clickable
      a.removeAttribute('target');
      a.setAttribute('aria-disabled', 'true');
    });
  }

  /* -----------------------------------------------------------------------
     BibTeX copy button
     ----------------------------------------------------------------------- */
  function initCopy() {
    $$('.bibtex').forEach((box) => {
      const btn = $('.copy-btn', box);
      const code = $('code', box);
      if (!btn || !code) return;
      const label = $('.copy-label', btn);
      let timer = null;
      const done = (ok) => {
        btn.classList.toggle('is-copied', ok);
        label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
        clearTimeout(timer);
        timer = setTimeout(() => { btn.classList.remove('is-copied'); label.textContent = 'Copy'; }, 1800);
      };
      btn.addEventListener('click', () => {
        const text = code.textContent;
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(() => done(true), () => fallback());
        } else {
          fallback();
        }
        function fallback() {   // select the entry so the visitor can copy it by hand
          const range = document.createRange(); range.selectNodeContents(code);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          let ok = false;
          try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
          done(ok);
        }
      });
    });
  }

  initPlaceholderLinks();
  initHeroTitle();
  initRelated();
  initCopy();
  initVideos();
  initCarousels();
  initFrameworkHighlight();
  initLightbox();
})();
