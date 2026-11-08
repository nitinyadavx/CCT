(function () {
  if (window.__CCT_V6__) return;
  window.__CCT_V6__ = true;

  const REPO_URL = 'https://github.com/nitinyadavx/CCT';

  // ============================================================================
  // 1. VIRTUAL WALL-CLOCK & NATIVE MEDIA PROTOTYPE HOOKS (Runs at document_start)
  // ============================================================================
  let forgedTimeOffsetMs = 0;
  let lockedSpeed = 1;
  let lastSpeedTick = Date.now();

  const origDateNow = Date.now.bind(Date);
  const origPerfNow = performance.now.bind(performance);

  // Advance wall-clock proportionally when speed > 1x or when watch time is forged
  const getForgedOffset = () => {
    const now = origDateNow();
    if (lockedSpeed > 1) {
      const elapsedReal = now - lastSpeedTick;
      if (elapsedReal > 0 && elapsedReal < 5000) {
        forgedTimeOffsetMs += elapsedReal * (lockedSpeed - 1);
      }
    }
    lastSpeedTick = now;
    return Math.round(forgedTimeOffsetMs);
  };

  try {
    Date.now = function () {
      return origDateNow() + getForgedOffset();
    };
    performance.now = function () {
      return origPerfNow() + getForgedOffset();
    };
    // Prevent tab-switching from pausing LMS videos
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  } catch (_) {}

  const MediaProto = window.HTMLMediaElement?.prototype;
  const origCurrentTime = MediaProto ? Object.getOwnPropertyDescriptor(MediaProto, 'currentTime') : null;
  const origPlaybackRate = MediaProto ? Object.getOwnPropertyDescriptor(MediaProto, 'playbackRate') : null;
  const origPlayed = MediaProto ? Object.getOwnPropertyDescriptor(MediaProto, 'played') : null;

  if (MediaProto) {
    // 1. Spoof video.played TimeRanges so LMS trackers see [0 -> duration] as watched
    try {
      Object.defineProperty(MediaProto, 'played', {
        configurable: true,
        enumerable: true,
        get() {
          if (this.__cctForgedPlayed && Number.isFinite(this.duration) && this.duration > 0) {
            const dur = this.duration;
            return {
              length: 1,
              start(i) {
                if (i !== 0) throw new DOMException('IndexSizeError');
                return 0;
              },
              end(i) {
                if (i !== 0) throw new DOMException('IndexSizeError');
                return dur;
              }
            };
          }
          return origPlayed ? origPlayed.get.call(this) : { length: 0, start: () => 0, end: () => 0 };
        }
      });
    } catch (_) {}

    // 2. Lock playbackRate at the prototype level so Video.js / Coursera cannot reset it to 1x
    if (origPlaybackRate?.get && origPlaybackRate?.set) {
      try {
        Object.defineProperty(MediaProto, 'playbackRate', {
          configurable: true,
          enumerable: true,
          get() {
            return origPlaybackRate.get.call(this);
          },
          set(val) {
            const effective = lockedSpeed !== 1 && !QuizGuard.isCurrentViewQuiz() ? lockedSpeed : val;
            return origPlaybackRate.set.call(this, effective);
          }
        });
      } catch (_) {}
    }
  }

  // Deep Media Finder (pierces Shadow DOMs, ignores Storyline's blank #video-pen dummy videos)
  const getActiveMediaElements = (root = document) => {
    const results = new Set();
    const scan = (node) => {
      if (!node) return;
      if (node instanceof HTMLMediaElement) {
        const src = node.currentSrc || node.src || '';
        const isDummy =
          Boolean(node.closest?.('#video-pen')) ||
          src.startsWith('data:video/mp4') ||
          src.startsWith('data:audio/mp3');
        if (!isDummy) results.add(node);
      }
      if (node.shadowRoot) scan(node.shadowRoot);
      const children = node.children;
      if (children) {
        for (let i = 0; i < children.length; i++) scan(children[i]);
      }
    };
    scan(root.documentElement || root);
    return Array.from(results);
  };

  // ============================================================================
  // 2. STRICT QUIZ GUARDRAIL (Zero Quiz Skipping)
  // ============================================================================
  const QuizGuard = {
    QUIZ_WORDS: /\b(quiz|quizzes|assessment|exam|test|graded|knowledge\s*check|question|assignment|final\s*test|checkpoint|evaluation)\b/i,
    QUIZ_ROUTES: /(assessment_help_new|assignment_help_new|quiz|exam|attempt)/i,

    isTocNodeQuiz(el) {
      if (!el) return false;
      const text = [
        el.textContent || '',
        el.getAttribute('title') || '',
        el.getAttribute('onclick') || '',
        el.getAttribute('data-url') || '',
        el.id || ''
      ].join(' ');
      if (this.QUIZ_WORDS.test(text) || this.QUIZ_ROUTES.test(text)) return true;
      if (el.querySelector?.('._assmntStatusIcon, ._wrnigIcon')) return true;
      return false;
    },

    isStorylineSlideQuiz(slideModel, slideIdOverride = null) {
      try {
        const id = slideIdOverride || slideModel?.absoluteId || slideModel?.id || '';
        const rawLinks =
          window.DS?.frameModel?.frame?.navData?.outline?.links ||
          window.DS?.playerGlobals?.player?.getNavData?.() ||
          [];

        let outlineHit = false;
        const walkLinks = (links, parentQuiz = false) => {
          links.forEach((item) => {
            const label = `${item.displaytext || ''} ${item.slidetitle || ''}`;
            const isQ = parentQuiz || this.QUIZ_WORDS.test(label);
            if (item.slideid && (item.slideid === id || id.endsWith(item.slideid)) && isQ) {
              outlineHit = true;
            }
            if (Array.isArray(item.links)) walkLinks(item.links, isQ);
          });
        };
        walkLinks(rawLinks);
        if (outlineHit) return true;

        if (slideModel) {
          if (typeof slideModel.hasInteractions === 'function' && slideModel.hasInteractions()) return true;
          const title = (typeof slideModel.title === 'function' ? slideModel.title() : slideModel.get?.('title')) || '';
          if (this.QUIZ_WORDS.test(title)) return true;
          if (slideModel.get?.('isQuiz') || slideModel.get?.('quizId') || slideModel.get?.('interactions')?.length > 0) {
            return true;
          }
        }
      } catch (_) {}
      return false;
    },

    isCurrentViewQuiz() {
      // 1. FutureSkills Prime iEvolve TOC & SubHeader
      const activeToc = document.querySelector('#mySidenav .inner.innerActive, #mySidenav .innerActive');
      if (this.isTocNodeQuiz(activeToc)) return true;

      const subHeader = document.querySelector('.subText.desk_header, .subText.mobile_header');
      if (subHeader) {
        const hText = `${subHeader.getAttribute('title') || ''} ${subHeader.textContent || ''}`;
        if (this.QUIZ_WORDS.test(hText)) return true;
      }

      // 2. Articulate Storyline Active Slide & Submit Button
      if (window.DS && document.getElementById('preso')) {
        const curSlide = window.DS.windowManager?.getCurrentWindowSlide?.();
        if (this.isStorylineSlideQuiz(curSlide)) return true;

        const submitBtn = document.getElementById('submit');
        if (submitBtn && window.getComputedStyle(submitBtn).display !== 'none' && submitBtn.offsetWidth > 0) {
          return true;
        }

        const shadowQuizInputs = document.querySelector(
          '.acc-shadow-dom input[type="radio"], .acc-shadow-dom input[type="checkbox"], .acc-shadow-dom [role="radiogroup"]'
        );
        if (shadowQuizInputs) return true;
      }

      // 3. Universal LMS Quiz DOM (Coursera, edX, Udemy, Moodle)
      const selectors = [
        '[data-testid*="quiz" i]',
        '[data-testid*="assessment" i]',
        '.rc-FormPartsQuestion',
        '.rc-QuizAttemptHeader',
        '.assessment-container',
        'form[action*="quiz" i]',
        '.que.multichoice'
      ];
      return Boolean(document.querySelector(selectors.join(',')));
    }
  };

  // ============================================================================
  // 3. WATCH-TIME FORGERY & SMART SKIP ENGINE
  // ============================================================================
  const formatScorm12Time = (ms) => {
    const totalSec = Math.max(1, Math.floor(ms / 1000));
    const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const secs = String(totalSec % 60).padStart(2, '0');
    return `${hrs}:${mins}:${secs}.00`;
  };

  const formatScorm2004Time = (ms) => {
    const totalSec = Math.max(1, Math.floor(ms / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `PT${mins}M${secs}S`;
  };

  const formatDisplayTime = (ms) => {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = String(totalSec % 60).padStart(2, '0');
    return `${mins}m ${secs}s`;
  };

  // Propagate SCORM Watch Time to LMS APIs & sessionStorage (scorm_container.html)
  const commitForgedScormTime = (addedMs) => {
    if (addedMs <= 0) return;
    window.__CCT_TOTAL_FORGED_MS__ = (window.__CCT_TOTAL_FORGED_MS__ || 0) + addedMs;
    const totalMs = window.__CCT_TOTAL_FORGED_MS__;

    const scorm12Str = formatScorm12Time(totalMs);
    const scorm2004Str = formatScorm2004Time(totalMs);

    // 1. Update sessionStorage if inside FutureSkills scorm_container.html
    try {
      if (window.sessionStorage) {
        if (sessionStorage.getItem('cmi.core.session_time') !== null || sessionStorage.getItem('scorm_credit') !== null) {
          sessionStorage.setItem('cmi.core.session_time', scorm12Str);
          sessionStorage.setItem('cmi.core.total_time', scorm12Str);
        }
      }
    } catch (_) {}

    // 2. Update scormdriver.js / SCORM 1.2 & 2004 APIs across parent chain
    let win = window;
    for (let i = 0; i < 6 && win; i++) {
      try {
        if (typeof win.dtmStart !== 'undefined' && win.dtmStart instanceof Date) {
          win.dtmStart = new Date(win.dtmStart.getTime() - addedMs);
        }
        if (win.API?.LMSSetValue) {
          win.API.LMSSetValue('cmi.core.session_time', scorm12Str);
          win.API.LMSCommit?.('');
        }
        if (win.API_1484_11?.SetValue) {
          win.API_1484_11.SetValue('cmi.session_time', scorm2004Str);
          win.API_1484_11.Commit?.('');
        }
        if (typeof win.CommitData === 'function') {
          win.CommitData();
        }
      } catch (_) {}
      if (win === win.parent) break;
      try { win = win.parent; } catch (_) { break; }
    }
  };

  // Multi-Hop Frame Broadcaster (Reaches nested iframes at any depth)
  const broadcastDown = (msg) => {
    for (let i = 0; i < window.frames.length; i++) {
      try {
        window.frames[i].postMessage({ source: 'CCT_V6_DOWN', ...msg }, '*');
      } catch (_) {}
    }
  };

  // Report status up to top HUD
  const reportUp = (status, level = 'ok', engine = null) => {
    try {
      window.top.postMessage({ source: 'CCT_V6_UP', status, level, engine }, '*');
    } catch (_) {}
  };

  const Engine = {
    setSpeed(rate) {
      if (QuizGuard.isCurrentViewQuiz()) {
        reportUp('Quiz Protected — Speed Locked', 'warn', 'Quiz Guard');
        return;
      }

      lockedSpeed = rate;
      lastSpeedTick = origDateNow();
      broadcastDown({ cmd: 'SPEED', rate });

      let hit = false;

      // 1. Native HTML5 Media
      getActiveMediaElements().forEach((m) => {
        try {
          if (origPlaybackRate?.set) origPlaybackRate.set.call(m, rate);
          else m.playbackRate = rate;
          hit = true;
        } catch (_) {}
      });

      // 2. Video.js
      if (window.videojs && typeof window.videojs.getPlayers === 'function') {
        Object.values(window.videojs.getPlayers()).forEach((p) => {
          try {
            if (p && !p.isDisposed?.()) {
              p.playbackRate?.(rate);
              hit = true;
            }
          } catch (_) {}
        });
      }

      // 3. Articulate Storyline 360 Clock & Timeline
      if (window.DS && document.getElementById('preso')) {
        try {
          window.DS.appState?.setPlaybackSpeed?.(rate);
          if (window.DS.animationClock) window.DS.animationClock.playbackSpeed = rate;
          if (window.DS.pubSub && window.DS.events?.player?.PLAYBACK_SPEED_CHANGED) {
            window.DS.pubSub.trigger(window.DS.events.player.PLAYBACK_SPEED_CHANGED, rate);
          }
          hit = true;
        } catch (_) {}
      }

      if (hit || window === window.top) {
        reportUp(`Speed + Watch Clock Set to ${rate}×`, 'info', hit ? 'Media' : null);
      }
    },

    async skipAndForgeWatchTime() {
      if (QuizGuard.isCurrentViewQuiz()) {
        reportUp('Quiz Protected — Skip Blocked', 'warn', 'Quiz Guard');
        return;
      }

      // Relay to all child iframes
      broadcastDown({ cmd: 'SKIP' });

      let forgedMsThisAction = 0;
      let engineUsed = null;

      // --- A. UNIVERSAL HTML5 & VIDEO.JS PROGRESSIVE WATCH-TIME FORGERY ---
      const mediaElements = getActiveMediaElements();
      const vjsList =
        window.videojs && typeof window.videojs.getPlayers === 'function'
          ? Object.values(window.videojs.getPlayers()).filter((p) => p && !p.isDisposed?.())
          : [];

      for (const media of mediaElements) {
        const dur =
          Number.isFinite(media.duration) && media.duration > 0
            ? media.duration
            : media.seekable?.length > 0
            ? media.seekable.end(media.seekable.length - 1)
            : 0;

        if (dur > 0) {
          engineUsed = vjsList.length > 0 ? 'Video.js' : 'HTML5 Video';
          const startPos = Number.isFinite(media.currentTime) ? media.currentTime : 0;
          const remainingSec = Math.max(1, dur - startPos);
          const remainingMs = Math.round(remainingSec * 1000);

          // Mark played TimeRanges as 100% forged
          media.__cctForgedPlayed = true;
          media.muted = true;

          // Step through 35 progressive checkpoints so delta-clamped timeupdate listeners accumulate 100% watch time
          const STEPS = 35;
          const stepSec = remainingSec / STEPS;
          const stepMs = remainingMs / STEPS;

          for (let s = 1; s <= STEPS; s++) {
            const nextTime = Math.min(dur - 0.1, startPos + stepSec * s);
            forgedTimeOffsetMs += stepMs;

            try {
              if (origCurrentTime?.set) origCurrentTime.set.call(media, nextTime);
              else media.currentTime = nextTime;
            } catch (_) {}

            media.dispatchEvent(new Event('timeupdate', { bubbles: true }));
            vjsList.forEach((p) => {
              try { p.trigger?.('timeupdate'); } catch (_) {}
            });

            // Yield briefly every 7 steps so async player state listeners flush their watch-time buffers
            if (s % 7 === 0) {
              await new Promise((r) => setTimeout(r, 12));
            }
          }

          // Finalize media completion
          try {
            if (origCurrentTime?.set) origCurrentTime.set.call(media, dur);
            else media.currentTime = dur;
          } catch (_) {}

          media.play?.()?.catch?.(() => {});
          media.dispatchEvent(new Event('timeupdate', { bubbles: true }));
          media.dispatchEvent(new Event('ended', { bubbles: true }));
          vjsList.forEach((p) => {
            try {
              p.currentTime?.(dur);
              p.trigger?.('timeupdate');
              p.trigger?.('ended');
            } catch (_) {}
          });

          forgedMsThisAction = Math.max(forgedMsThisAction, remainingMs);
        }
      }

      // --- B. ARTICULATE STORYLINE 360 WATCH-TIME & TIMELINE FORGERY ---
      if (window.DS && document.getElementById('preso')) {
        try {
          const curSlide = window.DS.windowManager?.getCurrentWindowSlide?.();
          if (curSlide && !QuizGuard.isStorylineSlideQuiz(curSlide)) {
            engineUsed = 'Storyline';

            // 1. Detach mediaInterface sync lock in DS.animationClock (Module 5179)
            if (window.DS.animationClock?.mediaInterface) {
              window.DS.animationClock.endMediaSync?.(window.DS.animationClock.mediaInterface);
            }

            // 2. Read slide timeline total duration in ms
            const tl = curSlide.currentTimeline?.();
            const baseTl = curSlide.getBaseLayer?.()?.timeline?.();
            const slideDurMs =
              tl?.timelineDuration?.() ||
              tl?.duration?.() ||
              baseTl?.duration?.() ||
              Number(document.querySelector('input[data-ref="progressBar"]')?.max) ||
              180000;

            // 3. Influence Storyline's internal elapsed & course watch timers (Modules 675, 5179, 6824)
            forgedTimeOffsetMs += slideDurMs;
            curSlide.elapsedTime = (curSlide.elapsedTime || 0) + slideDurMs;
            if (window.DS.resumer && typeof window.DS.resumer.courseStartTime === 'number') {
              window.DS.resumer.courseStartTime -= slideDurMs;
            }
            if (window.DS.animationClock) {
              window.DS.animationClock.currentTime = (window.DS.animationClock.currentTime || 0) + slideDurMs;
            }

            // 4. Step timeline callbacks to 100% completion
            if (tl) {
              tl.onSeekStart?.();
              tl.progress?.(1);
              tl.seek?.(slideDurMs);
              tl.onSeekEnd?.();
            }
            if (baseTl && baseTl !== tl) {
              baseTl.progress?.(1);
              baseTl.seek?.(slideDurMs);
            }

            // 5. Record slide viewed in Resumer & LMS Manager
            curSlide.viewed = true;
            window.DS.resumer?.slideViewed?.(curSlide);
            window.DS.lmsManager?.slideViewed?.(curSlide);

            forgedMsThisAction = Math.max(forgedMsThisAction, slideDurMs);

            // 6. Advance to next slide ONLY if next slide is not a quiz
            const nextSlide = curSlide.nextSibling?.();
            if (nextSlide && QuizGuard.isStorylineSlideQuiz(nextSlide)) {
              commitForgedScormTime(forgedMsThisAction);
              reportUp(
                `+${formatDisplayTime(forgedMsThisAction)} Forged • Next is Quiz`,
                'warn',
                'Storyline'
              );
              return;
            }

            window.DS.pubSub?.trigger(window.DS.events.presentation.ON_OBJECT_EVENT, 'next_pressed');
            const nextBtn = document.getElementById('next');
            if (nextBtn) {
              nextBtn.classList.remove('cs-disabled');
              nextBtn.setAttribute('aria-disabled', 'false');
              nextBtn.click();
            }
          }
        } catch (e) {
          console.warn('[CCT] Storyline watch-time forge error:', e);
        }
      }

      // --- C. FUTURESKILLS PRIME iEVOLVE MARK AS READ ---
      if (document.getElementById('mySidenav') || typeof window.content_url === 'function') {
        const markBtn = document.querySelector('#markReadPopupBtn, .markReadIcon, [id*="markRead"]');
        if (markBtn && markBtn.offsetWidth > 0) {
          forgedTimeOffsetMs += 180000;
          forgedMsThisAction = Math.max(forgedMsThisAction, 180000);
          markBtn.click();
          if (!engineUsed) engineUsed = 'iEvolve';
        }
      }

      // --- D. COMMIT FORGED WATCH TIME TO SCORM ---
      if (forgedMsThisAction > 0) {
        commitForgedScormTime(forgedMsThisAction);
        reportUp(
          `+${formatDisplayTime(forgedMsThisAction)} Watch Time Committed`,
          'ok',
          engineUsed || 'Media'
        );
      }
    },

    nextSafeUnit() {
      broadcastDown({ cmd: 'NEXT_UNIT' });

      if (document.getElementById('mySidenav')) {
        const units = Array.from(document.querySelectorAll('#mySidenav .inner'));
        const curIdx = units.findIndex((u) => u.classList.contains('innerActive'));
        if (curIdx !== -1 && curIdx + 1 < units.length) {
          const nextNode = units[curIdx + 1];
          const title = (nextNode.textContent || 'Next Unit').trim().replace(/\s+/g, ' ').slice(0, 22);
          nextNode.click();
          if (QuizGuard.isTocNodeQuiz(nextNode)) {
            reportUp(`Opened Quiz: ${title} (Locked)`, 'warn', 'Quiz Guard');
          } else {
            reportUp(`Loaded: ${title}`, 'ok', 'iEvolve');
          }
          return;
        }
      }

      const courseraNext = document.querySelector(
        '[data-testid="next-item"], button[aria-label*="Next Item" i], .rc-NextItemButton button'
      );
      if (courseraNext) {
        courseraNext.click();
        reportUp('Advanced to Next Item', 'ok', 'Coursera');
      }
    }
  };

  // ============================================================================
  // 4. CROSS-FRAME MESSAGE BUS
  // ============================================================================
  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;

    if (e.data.source === 'CCT_V6_DOWN') {
      if (e.data.cmd === 'SKIP') Engine.skipAndForgeWatchTime();
      if (e.data.cmd === 'SPEED') Engine.setSpeed(Number(e.data.rate) || 1);
      if (e.data.cmd === 'NEXT_UNIT') Engine.nextSafeUnit();
    }

    if (e.data.source === 'CCT_V6_UP' && window === window.top) {
      if (window.__CCT_UPDATE_HUD__) {
        window.__CCT_UPDATE_HUD__(e.data);
      }
    }
  });

  // ============================================================================
  // 5. APPLE HIG DYNAMIC ISLAND HUD (Top Window Only)
  // ============================================================================
  const mountAppleHUD = () => {
    if (window !== window.top) return;
    if (!document.body || document.getElementById('cct-v6-island')) return;

    const host = document.createElement('div');
    host.id = 'cct-v6-island';
   host.style.cssText = 'position: fixed; bottom: 24px; right: 24px; z-index: 2147483647; display: none;';
    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyC') {
        host.style.display = host.style.display === 'none' ? 'block' : 'none';
      }
    });
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          padding: 24px;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif;
          -webkit-font-smoothing: antialiased;
        }
        .island {
          opacity: 0;
          transform: translateY(12px) scale(0.95);
          pointer-events: none;
          width: 288px;
          background: rgba(22, 22, 24, 0.80);
          backdrop-filter: blur(32px) saturate(200%);
          -webkit-backdrop-filter: blur(32px) saturate(200%);
          border: 0.5px solid rgba(255, 255, 255, 0.18);
          border-radius: 24px;
          padding: 15px;
          color: #F5F5F7;
          box-shadow: 0 24px 52px rgba(0, 0, 0, 0.55), inset 0 0.5px 0 rgba(255, 255, 255, 0.24);
          transition: opacity 0.28s ease, transform 0.32s cubic-bezier(0.32, 0.72, 0, 1), width 0.38s cubic-bezier(0.32, 0.72, 0, 1);
          user-select: none;
          overflow: hidden;
        }
        :host(:hover) .island {
          opacity: 1;
          transform: translateY(0) scale(1);
          pointer-events: auto;
        }
        .island.compact {
          width: 154px;
          padding: 9px 14px;
          border-radius: 999px;
        }
        .island.compact .body {
          max-height: 0;
          opacity: 0;
          margin-top: 0;
          pointer-events: none;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .orb {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #30D158;
          box-shadow: 0 0 10px #30D158;
          transition: all 0.3s ease;
        }
        .title {
          font-size: 13px;
          font-weight: 600;
          letter-spacing: -0.015em;
          color: #FFFFFF;
        }
        .pill {
          font-size: 10px;
          font-weight: 500;
          padding: 2px 8px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.1);
          color: #EBEBF599;
          border: 0.5px solid rgba(255, 255, 255, 0.08);
        }
        .min-btn {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          border: none;
          background: rgba(255, 255, 255, 0.08);
          color: #EBEBF599;
          font-size: 12px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s cubic-bezier(0.32, 0.72, 0, 1);
        }
        .min-btn:hover {
          background: rgba(255, 255, 255, 0.18);
          color: #FFF;
          transform: scale(1.08);
        }
        .body {
          max-height: 280px;
          opacity: 1;
          margin-top: 12px;
          display: flex;
          flex-direction: column;
          gap: 9px;
          transition: all 0.38s cubic-bezier(0.32, 0.72, 0, 1);
        }
        .status-box {
          font-size: 11px;
          font-weight: 500;
          color: #EBEBF5CC;
          background: rgba(0, 0, 0, 0.36);
          padding: 7px 10px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border: 0.5px solid rgba(255, 255, 255, 0.07);
        }
        .btn-primary {
          background: linear-gradient(180deg, #1A8CFF 0%, #007AFF 100%);
          color: #FFFFFF;
          border: none;
          border-radius: 12px;
          padding: 10px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          box-shadow: 0 4px 14px rgba(0, 122, 255, 0.35), inset 0 0.5px 0 rgba(255, 255, 255, 0.3);
          transition: transform 0.18s cubic-bezier(0.32, 0.72, 0, 1), filter 0.18s ease;
        }
        .btn-primary:hover { filter: brightness(1.08); }
        .btn-primary:active { transform: scale(0.96); }
        .segmented {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          background: rgba(118, 118, 128, 0.24);
          padding: 3px;
          border-radius: 11px;
          gap: 3px;
        }
        .seg-btn {
          background: transparent;
          color: #F5F5F7;
          border: none;
          border-radius: 8px;
          padding: 6px 0;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.32, 0.72, 0, 1);
        }
        .seg-btn:hover, .seg-btn.active {
          background: rgba(255, 255, 255, 0.2);
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
        }
        .seg-btn:active { transform: scale(0.94); }
        .btn-secondary {
          background: rgba(255, 255, 255, 0.09);
          color: #F5F5F7;
          border: 0.5px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px;
          padding: 8px 10px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.32, 0.72, 0, 1);
        }
        .btn-secondary:hover { background: rgba(255, 255, 255, 0.16); }
        .btn-secondary:active { transform: scale(0.97); }
        .footer {
          margin-top: 2px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .sub-label {
          font-size: 10px;
          color: #EBEBF566;
          font-weight: 500;
        }
        .gh-sticker {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 4px 10px;
          border-radius: 999px;
          background: linear-gradient(135deg, rgba(255,255,255,0.16), rgba(255,255,255,0.05));
          border: 0.5px solid rgba(255, 255, 255, 0.22);
          color: #FFFFFF;
          font-size: 10px;
          font-weight: 600;
          text-decoration: none;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
          transition: transform 0.24s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.2s ease;
        }
        .gh-sticker:hover {
          transform: scale(1.06) translateY(-1px);
          background: linear-gradient(135deg, rgba(255,255,255,0.26), rgba(255,255,255,0.12));
        }
        .gh-sticker:active { transform: scale(0.95); }
        .gh-sticker svg { width: 12px; height: 12px; fill: currentColor; }
      </style>

      <div class="island" id="island">
        <div class="header">
          <div class="brand">
            <span class="orb" id="orb"></span>
            <span class="title">CCT</span>
            <span class="pill" id="engine-pill">Ready</span>
          </div>
          <button class="min-btn" id="min-btn" title="Collapse">–</button>
        </div>

        <div class="body">
          <div class="status-box">
            <span id="status-text">Watch-Time Forger Armed</span>
            <span>⏱️</span>
          </div>

          <button class="btn-primary" id="btn-skip">Smart Skip + Forge Watch Time</button>

          <div class="segmented">
            <button class="seg-btn active" data-rate="1">1×</button>
            <button class="seg-btn" data-rate="2">2×</button>
            <button class="seg-btn" data-rate="8">8×</button>
            <button class="seg-btn" data-rate="16">16×</button>
          </div>

          <button class="btn-secondary" id="btn-next">Next Lecture Unit (Quiz Safe)</button>

          <div class="footer">
            <span class="sub-label">Quizzes Protected</span>
            <a class="gh-sticker" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" title="CCT GitHub">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
              <span>CCT</span>
            </a>
          </div>
        </div>
      </div>
    `;

    const island = shadow.getElementById('island');
    const orb = shadow.getElementById('orb');
    const statusText = shadow.getElementById('status-text');
    const enginePill = shadow.getElementById('engine-pill');

    window.__CCT_UPDATE_HUD__ = ({ status, level, engine }) => {
      const colors = { ok: '#30D158', warn: '#FF9F0A', info: '#0A84FF', err: '#FF453A' };
      const c = colors[level] || colors.ok;
      if (status) statusText.textContent = status;
      if (engine) enginePill.textContent = engine;
      orb.style.background = c;
      orb.style.boxShadow = `0 0 10px ${c}`;
    };

    shadow.getElementById('min-btn').onclick = (e) => {
      const compact = island.classList.toggle('compact');
      e.currentTarget.textContent = compact ? '+' : '–';
    };

    shadow.getElementById('btn-skip').onclick = () => {
      statusText.textContent = 'Simulating Watch Time...';
      Engine.skipAndForgeWatchTime();
    };

    shadow.getElementById('btn-next').onclick = () => {
      Engine.nextSafeUnit();
    };

    shadow.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.onclick = () => {
        shadow.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        Engine.setSpeed(Number(btn.dataset.rate));
      };
    });

    document.body.appendChild(host);
  };

  /* Removing hidden HUD for now, as it may be confusing to users. The HUD can be re-enabled if needed in the future. */
  /*if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAppleHUD);
  } else {
    mountAppleHUD();*/
  }
})();