import json, sys, statistics as st

def analyze(path):
    r = json.load(open(path))
    on = r['raw']['onsets']; anchors = r['raw']['anchors']
    pts = sorted(on, key=lambda x: x[1]); groups = []; g = None
    for c, t in pts:
        if g is None or t - g['t0'] > 0.5:
            g = {'t0': t, 'by': {}}; groups.append(g)
        g['by'].setdefault(c, []).append(t)
    first = r['firstSwitch']['T'] + 0.3
    def rate_at(t):
        a = [x for x in anchors if x['t'] <= t]
        return a[-1]['rate'] if a else None
    rows = []
    for g in groups:
        if g['t0'] <= first or len(g['by']) < 6: continue
        rt = rate_at(g['t0'])
        if rt == 1 or rt is None: continue
        firsts = [v[0] for v in g['by'].values()]
        sf = (max(firsts) - min(firsts)) * 1000
        # Per stem, the copy nearest the median of the stems' last onsets: discounts an early WSOLA pre-echo.
        med = st.median([v[-1] for v in g['by'].values()])
        near = [min(v, key=lambda t: abs(t - med)) for v in g['by'].values()]
        sn = (max(near) - min(near)) * 1000
        rows.append({'t': g['t0'], 'rate': rt, 'firstOnsetMs': sf, 'alignedMs': sn, 'doubled': sum(len(v) > 1 for v in g['by'].values())})
    ev = r['events']
    after = []
    for e in ev:
        nxt = next((x for x in rows if x['t'] > e['T'] + 0.02), None)
        nx_any = next((g for g in groups if g['t0'] > e['T'] + 0.02), None)
        after.append({'what': e['what'], 'firstOnsetMs': None if not nxt else round(nxt['firstOnsetMs'], 1), 'alignedMs': None if not nxt else round(nxt['alignedMs'], 1), 'afterS': None if not nxt else round(nxt['t'] - e['T'], 2)})
    fo = [x['firstOnsetMs'] for x in rows]; al = [x['alignedMs'] for x in rows]
    return {
        'file': path.split('/')[-1], 'rate': r['rate'], 'loadBefore': r['loadBefore'], 'loadAfter': r['loadAfter'],
        'markers': len(rows), 'firstOnset': {'max': round(max(fo), 1), 'mean': round(st.mean(fo), 1), 'p95': round(sorted(fo)[int(len(fo) * .95)], 1), 'over50': sum(x > 50 for x in fo)},
        'aligned': {'max': round(max(al), 1), 'mean': round(st.mean(al), 1), 'p95': round(sorted(al)[int(len(al) * .95)], 1), 'over50': sum(x > 50 for x in al)},
        'groupsWithDoubledStem': sum(1 for x in rows if x['doubled']),
        'cpuRendererPct': r['cpu']['renderer'], 'underruns': r['playoutStats'], 'firstSwitch': r['firstSwitch'], 'switches': r['switches'],
        'nodesCreated': r['nodesCreated'], 'g2': r['g2Summary'], 'firstAfterEvent': after,
    }

out = [analyze(p) for p in sys.argv[1:]]
print(json.dumps(out, indent=1))
