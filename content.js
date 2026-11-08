(function () {
  if (window.__CCT_V8__) return;
  window.__CCT_V8__ = true;

  const STORAGE_KEY = '__cct_v8_config__';

  const getConfig = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { running: false, speed: 16 };
    } catch (_) {
      return { running: false, speed: 16 };
    }
  };

  const setConfig = (patch) => {
    const next = { ...getConfig(), ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_) {}
    return next;
  };

  let config = getConfig();
  let busy = false;

  // Keep background tabs active so videos never auto-pause
  try {
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  } catch (_) {}

  // ============================================================================
  // 1. NATIVE PROTOTYPE HOOKS FOR PLAYED RANGES & ENDED STATE
  // ============================================================================
  const MediaProto = window.HTMLMediaElement?.prototype;
  const origCurrentTime = MediaProto ? Object.getOwnPropertyDescriptor(MediaProto, 'currentTime') : null;
  const origPlaybackRate = MediaProto ? Object.getOwnPropertyDescriptor(MediaProto, 'playbackRate') : null;
  const origPlayed = MediaProto ? Object.getOwnPropertyDescriptor(MediaProto, 'played') : null;
  const origEnded = MediaProto ? Object.getOwnPropertyDescriptor(MediaProto, 'ended') : null;

  if (MediaProto) {
    try {
      Object.defineProperty(MediaProto, 'played', {
        configurable: true,
        enumerable: true,
        get() {
          if (this.__cctForged && Number.isFinite(this.duration) && this.duration > 0) {
            const d = this.duration;
            return {
              length: 1,
              start: () => 0,
              end: () => d
            };
          }
          return origPlayed ? origPlayed.get.call(this) : { length: 0, start: () => 0, end: () => 0 };
        }
      });

      Object.defineProperty(MediaProto, 'ended', {
        configurable: true,
        enumerable: true,
        get() {
          if (this.__cctEnded) return true;
          return origEnded ? origEnded.get.call(this) : false;
        }
      });
    } catch (_) {}
  }

  // Find real active videos (excludes Storyline's blank #video-pen base64 dummy videos)
  const getRealVideos = (root = document) => {
    const list = [];
    const walk = (node) => {
      if (!node) return;
      if (node instanceof HTMLMediaElement) {
        const src = node.currentSrc || node.src || '';
        const isDummy =
          Boolean(node.closest?.('#video-pen')) ||
          src.startsWith('data:video/mp4') ||
          src.startsWith('data:audio/mp3');
        if (!isDummy) list.push(node);
      }
      if (node.shadowRoot) walk(node.shadowRoot);
      const children = node.children;
      if (children) {
        for (let i = 0; i < children.length; i++) walk(children[i]);
      }
    };
    walk(root.documentElement || root);
    return list;
  };

  // ============================================================================
  // 2. STRICT QUIZ GUARDRAIL (NEVER SKIPS QUIZZES)
  // ============================================================================
  const QuizGuard = {
    QUIZ_REGEX: /\b(quiz|quizzes|assessment|exam|test|graded|knowledge\s*check|question|assignment|final\s*test|checkpoint|evaluation)\b/i,
    ROUTE_REGEX: /(assessment_help_new|assignment_help_new|quiz|exam|attempt)/i,

    isTocItemQuiz(el) {
      if (!el) return false;
      const raw = [
        el.textContent || '',
        el.getAttribute('title') || '',
        el.getAttribute('onclick') || '',
        el.getAttribute('data-url') || '',
        el.id || ''
      ].join(' ');
      return (
        this.QUIZ_REGEX.test(raw) ||
        this.ROUTE_REGEX.test(raw) ||
        Boolean(el.querySelector?.('._assmntStatusIcon, ._wrnigIcon'))
      );
    },

    isStorylineSlideQuiz(slideModel, slideIdOverride = null) {
      try {
        const id = slideIdOverride || slideModel?.absoluteId || slideModel?.id || '';
        const links =
          window.DS?.frameModel?.frame?.navData?.outline?.links ||
          window.DS?.playerGlobals?.player?.getNavData?.() ||
          [];

        let isQuizInOutline = false;
        const scan = (arr, parentQuiz = false) => {
          arr.forEach((item) => {
            const title = `${item.displaytext || ''} ${item.slidetitle || ''}`;
            const q = parentQuiz || this.QUIZ_REGEX.test(title);
            if (item.slideid && (item.slideid === id || id.endsWith(item.slideid)) && q) {
              isQuizInOutline = true;
            }
            if (Array.isArray(item.links)) scan(item.links, q);
          });
        };
        scan(links);
        if (isQuizInOutline) return true;

        if (slideModel) {
          if (typeof slideModel.hasInteractions === 'function' && slideModel.hasInteractions()) return true;
          const sTitle = (typeof slideModel.title === 'function' ? slideModel.title() : slideModel.get?.('title')) || '';
          if (this.QUIZ_REGEX.test(sTitle)) return true;
          if (slideModel.get?.('isQuiz') || slideModel.get?.('quizId') || slideModel.get?.('interactions')?.length > 0) {
            return true;
          }
        }
      } catch (_) {}
      return false;
    },

    isQuizOnScreen() {
      const activeToc = document.querySelector('#mySidenav .inner.innerActive, #mySidenav .innerActive');
      if (this.isTocItemQuiz(activeToc)) return true;

      const subHeader = document.querySelector('.subText.desk_header, .subText.mobile_header');
      if (subHeader) {
        const hText = `${subHeader.getAttribute('title') || ''} ${subHeader.textContent || ''}`;
        if (this.QUIZ_REGEX.test(hText)) return true;
      }

      if (window.DS && document.getElementById('preso')) {
        const curSlide = window.DS.windowManager?.getCurrentWindowSlide?.();
        if (this.isStorylineSlideQuiz(curSlide)) return true;

        const submitBtn = document.getElementById('submit');
        if (submitBtn && window.getComputedStyle(submitBtn).display !== 'none' && submitBtn.offsetWidth > 0) {
          return true;
        }

        const quizInputs = document.querySelector(
          '.acc-shadow-dom input[type="radio"], .acc-shadow-dom input[type="checkbox"], .acc-shadow-dom [role="radiogroup"]'
        );
        if (quizInputs) return true;
      }

      const domQuiz = document.querySelector(
        '[data-testid*="quiz" i], [data-testid*="assessment" i], .rc-FormPartsQuestion, .rc-QuizAttemptHeader, .assessment-container, form[action*="quiz" i], .que.multichoice'
      );
      return Boolean(domQuiz);
    }
  };

  // ============================================================================
  // 3. UNIVERSAL PLAY + WATCH-TIME FORGERY + COMPLETION ENGINE
  // ============================================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const seekAndWait = (video, targetTime) =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', finish);
        resolve();
      };
      video.addEventListener('seeked', finish);
      setTimeout(finish, 260);
      try {
        if (origCurrentTime?.set) origCurrentTime.set.call(video, targetTime);
        else video.currentTime = targetTime;
      } catch (_) {
        finish();
      }
    });

  const formatScorm12Time = (ms) => {
    const sec = Math.max(1, Math.floor(ms / 1000));
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s}.00`;
  };

  const commitScormWatchTime = (addedMs) => {
    if (addedMs <= 0) return;
    window.__CCT_WATCH_MS__ = (window.__CCT_WATCH_MS__ || 0) + addedMs;
    const s12 = formatScorm12Time(window.__CCT_WATCH_MS__);

    try {
      if (window.sessionStorage && (sessionStorage.getItem('cmi.core.session_time') !== null || sessionStorage.getItem('scorm_credit') !== null)) {
        sessionStorage.setItem('cmi.core.session_time', s12);
        sessionStorage.setItem('cmi.core.total_time', s12);
      }
    } catch (_) {}

    let win = window;
    for (let i = 0; i < 6 && win; i++) {
      try {
        if (win.dtmStart instanceof Date) {
          win.dtmStart = new Date(win.dtmStart.getTime() - addedMs);
        }
        if (win.API?.LMSSetValue) {
          win.API.LMSSetValue('cmi.core.session_time', s12);
          win.API.LMSCommit?.('');
        }
        if (typeof win.CommitData === 'function') win.CommitData();
      } catch (_) {}
      if (win === win.parent) break;
      try { win = win.parent; } catch (_) { break; }
    }
  };

  const broadcastToSubframes = (payload) => {
    for (let i = 0; i < window.frames.length; i++) {
      try {
        window.frames[i].postMessage({ source: 'CCT_V8_BUS', ...payload }, '*');
      } catch (_) {}
    }
  };

  const Engine = {
    unlockPlayOverlays() {
      // Dismiss FutureSkills tour overlay if present
      const tourEnd = document.querySelector('#slip._skipTour');
      if (tourEnd && tourEnd.offsetWidth > 0) tourEnd.click();

      // Click any start/play overlay buttons in Storyline or Video.js
      document
        .querySelectorAll('#mobile-start-button, .vjs-big-play-button, .video-player-poster')
        .forEach((btn) => {
          if (btn.offsetWidth > 0 || btn.offsetHeight > 0) btn.click();
        });

      // If Storyline play-pause button is currently paused, click it
      const slPlayBtn = document.getElementById('play-pause');
      if (slPlayBtn && document.body.classList.contains('timeline-paused')) {
        slPlayBtn.click();
      }
    },

    applySpeed(rate) {
      config = setConfig({ speed: rate });
      broadcastToSubframes({ cmd: 'SPEED', rate });

      if (QuizGuard.isQuizOnScreen()) return;

      getRealVideos().forEach((v) => {
        try {
          if (origPlaybackRate?.set) origPlaybackRate.set.call(v, rate);
          else v.playbackRate = rate;
        } catch (_) {}
      });

      if (window.videojs && typeof window.videojs.getPlayers === 'function') {
        Object.values(window.videojs.getPlayers()).forEach((p) => {
          try { p?.playbackRate?.(rate); } catch (_) {}
        });
      }

      if (window.DS && document.getElementById('preso')) {
        try {
          window.DS.appState?.setPlaybackSpeed?.(rate);
          if (window.DS.animationClock) window.DS.animationClock.playbackSpeed = rate;
        } catch (_) {}
      }
    },

    async playAndCompleteCurrentUnit() {
      if (busy) return;
      if (QuizGuard.isQuizOnScreen()) {
        setConfig({ running: false });
        return;
      }

      busy = true;
      broadcastToSubframes({ cmd: 'COMPLETE_NOW' });

      try {
        this.unlockPlayOverlays();

        let forgedMs = 0;
        const videos = getRealVideos();
        const vjsPlayers =
          window.videojs && typeof window.videojs.getPlayers === 'function'
            ? Object.values(window.videojs.getPlayers()).filter((p) => p && !p.isDisposed?.())
            : [];

        // --- STAGE 1: PLAY & COMPLETE ALL VIDEOS (Video.js / Storyline / HTML5 / Coursera) ---
        for (const video of videos) {
          video.__cctEnded = false;
          video.muted = true;

          // 1. Start genuine playback so LMS registers "playing" state
          try {
            await video.play();
          } catch (_) {
            video.dispatchEvent(new Event('play', { bubbles: true }));
            video.dispatchEvent(new Event('playing', { bubbles: true }));
          }
          vjsPlayers.forEach((p) => {
            try {
              p.muted?.(true);
              p.play?.();
            } catch (_) {}
          });

          // Wait up to 600ms for video metadata (duration) to populate
          for (let wait = 0; wait < 6 && (!Number.isFinite(video.duration) || video.duration <= 0); wait++) {
            await sleep(100);
          }

          const dur =
            Number.isFinite(video.duration) && video.duration > 0
              ? video.duration
              : video.seekable?.length > 0
              ? video.seekable.end(video.seekable.length - 1)
              : 0;

          if (dur > 0) {
            video.__cctForged = true;
            const remainingMs = Math.round(dur * 1000);

            // 2. Let video play genuinely for 300ms
            await sleep(300);

            // 3. Step through 4 awaited checkpoints (25%, 50%, 75%, 98%) so watch-time trackers log full duration
            const checkpoints = [0.25, 0.5, 0.75, 0.98];
            for (const ratio of checkpoints) {
              await seekAndWait(video, dur * ratio);
              video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
              vjsPlayers.forEach((p) => {
                try { p.trigger?.('timeupdate'); } catch (_) {}
              });
              await sleep(60);
            }

            // 4. Seek to 0.3s before end and let it finish naturally so browser sets video.ended = true
            await seekAndWait(video, Math.max(0, dur - 0.3));
            try {
              await video.play();
            } catch (_) {}
            await sleep(350);

            // 5. Ensure final ended state is committed
            video.__cctEnded = true;
            try {
              if (origCurrentTime?.set) origCurrentTime.set.call(video, dur);
              else video.currentTime = dur;
            } catch (_) {}
            video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
            video.dispatchEvent(new Event('ended', { bubbles: true }));
            vjsPlayers.forEach((p) => {
              try {
                p.trigger?.('timeupdate');
                p.trigger?.('ended');
              } catch (_) {}
            });

            forgedMs = Math.max(forgedMs, remainingMs);
          }
        }

        // --- STAGE 2: ARTICULATE STORYLINE 360 SLIDE COMPLETION & ADVANCE ---
        if (window.DS && document.getElementById('preso')) {
          try {
            const curSlide = window.DS.windowManager?.getCurrentWindowSlide?.();
            if (curSlide && !QuizGuard.isStorylineSlideQuiz(curSlide)) {
              const tl = curSlide.currentTimeline?.();
              const baseTl = curSlide.getBaseLayer?.()?.timeline?.();
              const slideDurMs =
                tl?.timelineDuration?.() ||
                tl?.duration?.() ||
                baseTl?.duration?.() ||
                Number(document.querySelector('input[data-ref="progressBar"]')?.max) ||
                192500;

              // Inject full watch time into Storyline's slide & course timers
              curSlide.elapsedTime = slideDurMs;
              if (window.DS.resumer && typeof window.DS.resumer.courseStartTime === 'number') {
                window.DS.resumer.courseStartTime -= slideDurMs;
              }

              if (tl) {
                tl.onSeekStart?.();
                tl.progress?.(1);
                tl.onSeekEnd?.();
              }
              if (baseTl && baseTl !== tl) {
                baseTl.progress?.(1);
              }

              // Mark slide viewed in Resumer, Scorings & LMS Manager
              curSlide.viewed = true;
              window.DS.resumer?.slideViewed?.(curSlide);
              window.DS.lmsManager?.getScorings?.()?.incrementViewed?.(curSlide);
              window.DS.resumer?.savePresentationData?.(curSlide.getScene?.());
              forgedMs = Math.max(forgedMs, slideDurMs);

              // Find next slide in Storyline outline
              const outlineItems = Array.from(
                document.querySelectorAll('#outline-content .cs-listitem[data-ref]:not([data-is-scene="true"])')
              );
              const curRef = curSlide.absoluteId;
              const curIdx = outlineItems.findIndex((el) => el.getAttribute('data-ref') === curRef);

              // Check if we are on the final slide of the Storyline course
              if (curIdx !== -1 && curIdx === outlineItems.length - 1) {
                window.DS.pubSub?.trigger(window.DS.events.course.VIEWED);
                window.DS.pubSub?.trigger(window.DS.events.course.MANUALLY_COMPLETED);
                window.DS.lmsManager?.viewedComplete?.();
                window.SetReachedEnd?.();
                window.CommitData?.();
              } else {
                const nextEl = curIdx !== -1 ? outlineItems[curIdx + 1] : null;
                const nextRef = nextEl?.getAttribute('data-ref');
                if (nextRef && QuizGuard.isStorylineSlideQuiz(null, nextRef)) {
                  setConfig({ running: false });
                  return;
                }

                // Try standard Next button first, then fallback to direct NEXT_SLIDE request
                window.DS.pubSub?.trigger(window.DS.events.presentation.ON_OBJECT_EVENT, 'next_pressed');
                const nextBtn = document.getElementById('next');
                if (nextBtn) {
                  nextBtn.classList.remove('cs-disabled');
                  nextBtn.setAttribute('aria-disabled', 'false');
                  nextBtn.click();
                }

                await sleep(350);
                if (
                  nextRef &&
                  window.DS.windowManager?.getCurrentWindowSlide?.()?.absoluteId === curRef
                ) {
                  window.DS.pubSub?.trigger(window.DS.events.request.NEXT_SLIDE, nextRef);
                }
              }
            }
          } catch (_) {}
        }

        // --- STAGE 3: FUTURESKILLS PRIME iEVOLVE "MARK AS READ" & NEXT UNIT ---
        if (document.getElementById('mySidenav') || typeof window.content_url === 'function') {
          const markBtns = document.querySelectorAll(
            '#markReadPopupBtn, .markReadIcon, [id*="markRead" i], .mark_as_read'
          );
          markBtns.forEach((btn) => {
            if (btn.offsetWidth > 0 || btn.offsetHeight > 0) btn.click();
          });

          await sleep(300);

          // Confirm any "Mark as Read" confirmation popup
          document
            .querySelectorAll('#markAsReadYes, #confirmMarkRead, .mark_details button, .modal.in .btn-primary')
            .forEach((btn) => {
              if (btn.offsetWidth > 0) btn.click();
            });

          const activeToc = document.querySelector('#mySidenav .inner.innerActive');
          if (activeToc) activeToc.classList.add('marked');

          if (forgedMs === 0) forgedMs = 180000;
        }

        if (forgedMs > 0) {
          commitScormWatchTime(forgedMs);
        }
      } finally {
        busy = false;
      }
    },

    advanceToNextUnit() {
      broadcastToSubframes({ cmd: 'NEXT_UNIT' });

      if (document.getElementById('mySidenav')) {
        const units = Array.from(document.querySelectorAll('#mySidenav .inner'));
        const curIdx = units.findIndex((u) => u.classList.contains('innerActive'));
        if (curIdx !== -1 && curIdx + 1 < units.length) {
          const nextUnit = units[curIdx + 1];
          if (QuizGuard.isTocItemQuiz(nextUnit)) {
            setConfig({ running: false });
            nextUnit.click(); // Open the quiz for the user and halt automation
            return;
          }
          nextUnit.click();
        }
      }

      const courseraNext = document.querySelector(
        '[data-testid="next-item"], button[aria-label*="Next Item" i], .rc-NextItemButton button'
      );
      if (courseraNext && !QuizGuard.isTocItemQuiz(courseraNext)) {
        courseraNext.click();
      }
    }
  };

  // ============================================================================
  // 4. BACKGROUND AUTO-PILOT LOOP (Runs when One-Click Automation is Active)
  // ============================================================================
  setInterval(async () => {
    config = getConfig();
    if (!config.running || busy) return;

    if (QuizGuard.isQuizOnScreen()) {
      setConfig({ running: false });
      return;
    }

    await Engine.playAndCompleteCurrentUnit();

    if (window === window.top && getConfig().running && !QuizGuard.isQuizOnScreen()) {
      await sleep(900);
      Engine.advanceToNextUnit();
    }
  }, 2400);

  // ============================================================================
  // 5. MESSAGE LISTENER (From Popup & Parent Frames)
  // ============================================================================
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.source !== 'CCT_V8_BUS') return;

    if (e.data.cmd === 'ONE_CLICK_START') {
      setConfig({ running: true, speed: e.data.speed || 16 });
      Engine.applySpeed(e.data.speed || 16);
      Engine.playAndCompleteCurrentUnit();
    } else if (e.data.cmd === 'COMPLETE_NOW') {
      Engine.playAndCompleteCurrentUnit();
    } else if (e.data.cmd === 'STOP') {
      setConfig({ running: false });
    } else if (e.data.cmd === 'SPEED') {
      Engine.applySpeed(Number(e.data.rate) || 1);
    } else if (e.data.cmd === 'NEXT_UNIT') {
      Engine.advanceToNextUnit();
    }
  });

  // Clean up any leftover on-screen HUD elements from older versions
  window.addEventListener('DOMContentLoaded', () => {
    document
      .querySelectorAll('#cct-v6-island, #cct-v7-hud, #cct-clean-root, #cct-apple-island, #cct-apple-hud')
      .forEach((el) => el.remove());
  });
})();