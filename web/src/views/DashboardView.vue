<template>
  <div class="page">
    <PageHeader :title="isTw ? 'TRAE Work' : isQw ? '千问办公' : '仪表盘'">
      <template #sub>
        {{ isTw ? '额度、签到与用量总览'
          : isQw ? '积分额度、登录态与用量总览' : '账号池健康度、上游状态与今日用量总览' }}
        <template v-if="lastRefresh"> · 更新于 {{ lastRefresh }}</template>
      </template>
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="refresh(true)">刷新</a-button>
      </template>
    </PageHeader>

    <!-- ============ TRAE Work：额度 + 签到 + 账号，与千问三池不同 ============ -->
    <template v-if="isTw">
      <a-row :gutter="[16, 16]">
        <a-col :span="6">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="剩余额度" :value="twTotals.remain ?? '—'" />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="twTotals.limit">上限合计 {{ twTotals.limit.toLocaleString('zh-CN') }}</template>
              <span v-else>上游未给出额度上限</span>
            </div>
          </a-card>
        </a-col>
        <a-col :span="6">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="今日已签到" :value="`${twTotals.checked} / ${twRows.length}`" />
            <div class="text-xs text-slate-500 mt-2">签到每日一次，幂等</div>
          </a-card>
        </a-col>
        <a-col :span="6">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="今日请求" :value="usage?.cards.today.requests ?? '—'" value-style="color:#22d3ee" />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="usage">{{ compact(usage.cards.today.tokens) }} Token</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :span="6">
          <a-card :bordered="false" class="h-full">
            <a-statistic
              title="通道状态"
              :value="twInfo?.ready ? '就绪' : '不可用'"
              :value-style="twInfo?.ready ? 'color:#34d399' : 'color:#f87171'"
            />
            <div class="text-xs text-slate-500 mt-2">
              {{ twInfo?.ready ? `可用账号 ${twInfo.accounts ?? 0} 个` : (twInfo?.error || '—') }}
            </div>
          </a-card>
        </a-col>
      </a-row>

      <a-row :gutter="[16, 16]" class="mt-4">
        <a-col :span="17">
          <a-card title="请求量趋势" :bordered="false" class="h-full">
            <template #extra><span class="text-xs text-slate-400">按天聚合</span></template>
            <a-empty v-if="!(usage?.daily || []).length" description="还没有 TRAE Work 请求记录" />
            <div v-else ref="tokChartEl" class="dash-chart" />
          </a-card>
        </a-col>
        <a-col :span="7">
          <a-card title="通道状态" :bordered="false" class="h-full">
            <a-descriptions :column="1" size="small">
              <a-descriptions-item label="账号">
                {{ twInfo?.account || '—' }}
                <span v-if="(twInfo?.accounts ?? 0) > 1" class="text-xs text-slate-400 ml-1">
                  等 {{ twInfo?.accounts }} 个
                </span>
              </a-descriptions-item>
              <a-descriptions-item label="access token">
                <span class="font-mono text-xs">{{ fmtExpire(twInfo?.tokenExpiresAt) }}</span>
              </a-descriptions-item>
              <a-descriptions-item label="refresh token">
                <span class="font-mono text-xs">{{ fmtExpire(twInfo?.refreshExpiresAt) }}</span>
                <a-tag v-if="twInfo?.refreshExpired" color="orange" class="ml-1">已过期</a-tag>
              </a-descriptions-item>
            </a-descriptions>
            <!-- 与千问的关键差异：TRAE 的凭证是我们自己换的，token 到期能自动续 -->
            <a-alert
              type="info"
              show-icon
              class="mt-3"
              message="凭证自持，可自动续期"
              description="access token 到期时网关用 refresh token 自动换新，不需要打开 TRAE 客户端。只有 refresh token 过期才需要重新登录。"
            />
          </a-card>
        </a-col>
      </a-row>

      <!-- 账号健康快照（多账号）：每账号一张卡，仿搭子/千问仪表盘。
           与千问的关键差异：TRAE 的 credits 会被消耗、由签到补充，
           所以健康条按「剩余额度占上限的比例」，而不是存活天数。 -->
      <a-card :bordered="false" class="mt-4">
        <template #title>
          <span>账号健康快照</span>
          <a-tag v-if="twAccounts.length" color="green" class="ml-2">
            在线 {{ twAccounts.filter(a => a.enabled && !a.refreshExpired).length }}
          </a-tag>
          <a-tag v-if="twDash?.summary.checkedInToday != null" color="blue" class="ml-1">
            今日已签 {{ twDash.summary.checkedInToday }} / {{ twAccounts.length }}
          </a-tag>
        </template>
        <a-empty v-if="!twAccounts.length" description="还没有添加 TRAE Work 账号，到「账号管理」加一个" />
        <a-row v-else :gutter="[16, 16]">
          <a-col v-for="a in twAccounts" :key="a.id" :span="8">
            <div class="p-3 border border-slate-200 rounded">
              <div class="flex items-center justify-between mb-2">
                <span class="font-medium truncate">{{ a.name }}</span>
                <a-tag :color="a.lastError ? 'red' : a.refreshExpired ? 'orange' : a.enabled ? 'green' : 'default'">
                  {{ a.lastError ? '异常' : a.refreshExpired ? '待重登' : a.enabled ? '在线' : '停用' }}
                </a-tag>
              </div>
              <div v-if="a.phone" class="text-xs text-slate-400 font-mono mb-2">
                {{ a.phone }}
                <span v-if="a.phoneSource === 'inferred-nickname'" class="text-slate-500 ml-1">（从昵称推断）</span>
              </div>
              <div class="h-1.5 bg-slate-100 rounded overflow-hidden mb-2">
                <div
                  class="h-full rounded transition-all"
                  :class="healthColorTw(a)"
                  :style="{ width: healthWidthTw(a) }"
                />
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-slate-500">
                  <template v-if="twCreditCap && a.credits != null">
                    剩余 {{ fmt(a.credits) }} / {{ fmt(twCreditCap) }}
                  </template>
                  <template v-else-if="a.daysAlive !== null">已用 {{ a.daysAlive }} 天</template>
                  <template v-else>额度未知</template>
                </span>
                <span :class="a.checkedInToday ? 'text-green-500' : 'text-slate-500'">
                  {{ a.checkedInToday ? '今日已签' : '今日未签' }}
                </span>
              </div>
              <div v-if="a.lastError" class="text-xs text-red-500 mt-1">{{ a.lastError }}</div>
            </div>
          </a-col>
        </a-row>
        <div v-if="twDash?.note" class="text-xs text-slate-400 mt-3">{{ twDash.note }}</div>
      </a-card>

      <!-- 今日积分明细：本地归因，按 req_id 与请求日志配对。
           成本取相邻 consumed 的差值——它是「这条请求花了多少」，
           与上面「剩余额度」是两回事，不要相加。 -->
      <a-card title="今日积分明细" :bordered="false" class="mt-4">
        <template #extra>
          <span class="text-xs text-slate-400">
            最近 {{ twRecords.length }} 条 · 合计 {{ fmt(twWindow.cost) }}
          </span>
        </template>
        <a-row :gutter="[16, 16]" class="mb-3">
          <a-col :span="6">
            <a-statistic title="今日消耗" :value="twToday?.cost ?? '—'" :precision="2" />
            <div class="text-xs text-slate-500 mt-1">按相邻账号游标差值算出</div>
          </a-col>
          <a-col :span="6">
            <a-statistic title="今日经网关请求" :value="twToday?.requests ?? '—'" />
            <div class="text-xs text-slate-500 mt-1">
              <a-tag v-if="twToday?.concurrent" color="orange" class="mr-1">并发 {{ twToday.concurrent }}</a-tag>
              仅统计经本网关的请求
            </div>
          </a-col>
          <a-col :span="12">
            <div class="text-xs text-slate-400 leading-relaxed">
              成本来自「同一账号相邻两次累计已消耗的差值」，不是上游账单——
              TRAE 的额度接口只给累计值，没有逐笔流水。
              每账号的第一条没有参照点，如实留空（显示 —）而不是补 0。
              与相邻请求并发时差值可能含对方的消耗，标记为「并发」。
            </div>
          </a-col>
        </a-row>
        <a-empty v-if="!twRecords.length" description="还没有经网关的积分记录" />
        <a-table
          v-else
          size="small"
          :data-source="twRecords"
          :columns="twRecordColumns"
          row-key="req_id"
          :pagination="{ pageSize: 10, size: 'small', showSizeChanger: false }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'ts'">
              <span class="text-xs">{{ new Date(record.ts).toLocaleString('zh-CN', { hour12: false }) }}</span>
            </template>
            <template v-else-if="column.key === 'account'">
              <span class="text-xs">{{ record.account || '—' }}</span>
            </template>
            <template v-else-if="column.key === 'model'">
              <span class="font-mono text-xs">{{ record.model || '—' }}</span>
            </template>
            <template v-else-if="column.key === 'cost'">
              <span v-if="record.cost != null" class="font-medium">{{ fmt(record.cost) }}</span>
              <span v-else class="text-slate-400">—</span>
              <a-tooltip v-if="record.cost != null && !record.exact" title="与相邻请求并发，差值可能含其它请求的消耗">
                <a-tag color="orange" class="ml-1">并发</a-tag>
              </a-tooltip>
            </template>
            <template v-else-if="column.key === 'remain'">
              <span class="text-xs text-slate-400">
                <template v-if="record.remain != null">{{ fmt(record.remain) }}</template>
                <template v-else>—</template>
              </span>
            </template>
            <template v-else-if="column.key === 'ms'">
              <span class="text-xs text-slate-400">{{ record.ms != null ? record.ms + ' ms' : '—' }}</span>
            </template>
          </template>
        </a-table>
      </a-card>
    </template>

    <!-- ============ 千问办公：积分卡片。它是另一套账——不消耗搭子积分、不进账号池，
         所以整块替换而不是与搭子的指标卡混排。 ============ -->
    <template v-else-if="isQw">
      <!-- 三个池子平级展示：月度与长期性质不同（订阅套餐 vs 充值赠送），
           不能合并成一张「付费额度」卡。 -->
      <a-row :gutter="[16, 16]">
        <a-col v-for="w in qwWallets" :key="w.id" :span="6">
          <a-card :bordered="false" class="h-full">
            <a-statistic :title="w.label" :value="w.balance ?? '—'" :precision="2"
              :value-style="w.kind === 'free' && (w.balance ?? 0) < 20 ? 'color:#fbbf24' : ''">
              <template #suffix><span class="text-sm text-slate-400">积分</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              <a-tag :color="w.kind === 'free' ? 'green' : 'orange'" class="mr-1">
                {{ w.kind === 'free' ? '免费' : '付费' }}
              </a-tag>
              <template v-if="w.resetAt">每天 00:00 重置</template>
              <template v-else>按有效期</template>
            </div>
            <!-- 今日已用：真实数据。上限由「观测峰值 + 配置兜底」得出，
                 未校准时如实说明数值可能偏小。 -->
            <div v-if="w.id === 'daily' && qw?.freeUsed != null" class="text-xs text-slate-500 mt-1">
              今日已用 {{ qw.freeUsed.toFixed(2) }} / {{ qw.limit }}
              <a-tag v-if="!qw.calibrated" color="orange" class="ml-1" title="尚未观测到接近满额的状态，实际消耗可能更多">
                待校准
              </a-tag>
            </div>
          </a-card>
        </a-col>

        <a-col :span="6">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="经本网关消耗" :value="qw?.today.total ?? '—'" :precision="4" />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="qw">
                <a-tag :color="qw.today.paid > 0 ? 'orange' : 'green'" class="mr-1">
                  {{ qw.today.paid > 0 ? '含付费' : '全部免费' }}
                </a-tag>
                免费 {{ qw.today.free.toFixed(4) }} · 付费 {{ qw.today.paid.toFixed(4) }}
              </template>
              <span v-else>—</span>
            </div>
            <div v-if="qw?.today.scope === 'gateway'" class="text-xs text-slate-400 mt-1">
              仅统计经本网关的请求；客户端/网页里的对话不计入
            </div>
          </a-card>
        </a-col>
      </a-row>

      <a-row :gutter="[16, 16]" class="mt-4">
        <a-col :span="17">
          <a-card title="积分消耗趋势" :bordered="false" class="h-full">
            <template #extra><span class="text-xs text-slate-400">按天聚合 · 免费与付费分开</span></template>
            <a-empty v-if="!qwDaily.length" description="还没有归因记录" />
            <div v-else ref="qwChartEl" class="qw-chart" />
          </a-card>
        </a-col>
        <a-col :span="7">
          <a-card title="通道状态" :bordered="false" class="h-full">
            <a-descriptions :column="1" size="small">
              <a-descriptions-item label="状态">
                <a-tag :color="qwInfo?.ready ? (qwInfo.refreshExpired ? 'orange' : 'green') : 'red'">
                  {{ qwInfo?.ready ? (qwInfo.refreshExpired ? '可用·待重登' : '正常') : '不可用' }}
                </a-tag>
              </a-descriptions-item>
              <a-descriptions-item label="wasm">
                <span class="font-mono text-xs">{{ qwInfo?.wasm || '—' }}</span>
              </a-descriptions-item>
              <a-descriptions-item label="主账号">
                {{ qwInfo?.account || '—' }}
                <span v-if="qwInfo?.tier" class="text-xs text-slate-400 ml-1">{{ qwInfo.tier }}</span>
                <a-tag v-if="qwAccounts.filter(a => a.active).length === 0" color="default" class="ml-1">
                  未设
                </a-tag>
              </a-descriptions-item>
              <a-descriptions-item label="access token">
                <span class="font-mono text-xs">{{ fmtExpire(qwInfo?.tokenExpiresAt) }}</span>
              </a-descriptions-item>
              <a-descriptions-item label="refresh token">
                <span class="font-mono text-xs">{{ fmtExpire(qwInfo?.refreshExpiresAt) }}</span>
                <a-tag v-if="qwInfo?.refreshExpired" color="orange" class="ml-1">已过期</a-tag>
              </a-descriptions-item>
            </a-descriptions>
            <a-alert
              v-if="qwInfo?.refreshExpired"
              type="warning"
              show-icon
              class="mt-3"
              message="refresh token 已过期"
              description="access token 到期后需在管理端「账号管理」删除该账号并重新登录，不要去打开千问客户端——客户端的登录态已经不再被这条通道使用。"
            />
          </a-card>
        </a-col>
      </a-row>

      <!-- 账号健康快照（多账号）：每账号一张卡，仿搭子仪表盘。
           千与搭子的「会员剩余天数」语义不同——这里用「账号存活天数」
           （从 createdAt 算到今天）。 -->
      <a-card :bordered="false" class="mt-4">
        <template #title>
          <span>账号健康快照</span>
          <a-tag v-if="qwAccounts.length" color="green" class="ml-2">
            在线 {{ qwAccounts.filter(a => a.enabled && a.usable).length }}
          </a-tag>
        </template>
        <a-empty v-if="!qwAccounts.length" description="还没有添加千问账号，到「账号管理」加一个" />
        <a-row v-else :gutter="[16, 16]">
          <a-col v-for="a in qwAccounts" :key="a.id" :span="8">
            <div class="p-3 border border-slate-200 rounded">
              <div class="flex items-center justify-between mb-2">
                <span class="font-medium truncate">
                  {{ a.name || a.username || '未命名' }}
                  <a-tag v-if="a.active" color="blue" class="ml-1">主账号</a-tag>
                </span>
                <a-tag :color="a.lastError ? 'red' : a.refreshExpired ? 'orange' : a.enabled && a.usable ? 'green' : 'default'">
                  {{ a.lastError ? '异常' : a.refreshExpired ? '待重登' : a.enabled && a.usable ? '在线' : '停用' }}
                </a-tag>
              </div>
              <div v-if="a.phone" class="text-xs text-slate-400 font-mono mb-2">
                {{ a.phone }}
              </div>
              <!-- 健康条：长度按账号存活天数，365 天为满。
                   与搭子的「会员剩余天数」不同——这是账号用了多久的客观度量，
                   满了不代表「过期」，只是看不到更老的。 -->
              <div class="h-1.5 bg-slate-100 rounded overflow-hidden mb-2">
                <div
                  class="h-full rounded transition-all"
                  :class="healthColorQw(a)"
                  :style="{ width: healthWidthQw(a) }"
                />
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-slate-500">
                  {{ a.daysAlive !== null ? a.daysAlive + ' 天' : '天数未知' }}
                </span>
                <span :class="a.points !== null && a.points < 0 ? 'text-red-500' : a.points !== null && a.points < 20 ? 'text-orange-500' : 'text-slate-600'">
                  {{ a.points !== null ? fmt(a.points) + ' 积分' : '积分未知' }}
                </span>
              </div>
              <div v-if="a.lastError" class="text-xs text-red-500 mt-1">{{ a.lastError }}</div>
            </div>
          </a-col>
        </a-row>
      </a-card>

      <!-- 今日积分明细：与 TRAE 侧同一套结构（本地归因、按 req_id 配对），
           但千问是**三个池子**，所以「免费/付费」要分列——消耗的是免费
           额度还是付费额度，是本通道最要紧的一件事。 -->
      <a-card title="今日积分明细" :bordered="false" class="mt-4">
        <template #extra>
          <span class="text-xs text-slate-400">
            最近 {{ qwRecords.length }} 条 · 合计 {{ fmtQw(qwWindow.total) }}
          </span>
        </template>
        <a-row :gutter="[16, 16]" class="mb-3">
          <a-col :span="6">
            <a-statistic title="今日消耗（经网关）" :value="fmtQw(qw?.today.total ?? 0)" />
            <div class="text-xs text-slate-500 mt-1">{{ qw?.today.requests ?? 0 }} 次请求</div>
          </a-col>
          <a-col :span="6">
            <a-statistic title="免费 / 付费" :value="`${fmtQw(qw?.today.free ?? 0)} / ${fmtQw(qw?.today.paid ?? 0)}`" />
            <div class="text-xs text-slate-500 mt-1">
              <a-tag :color="(qw?.today.paid ?? 0) > 0 ? 'orange' : 'green'" class="mr-1">
                {{ (qw?.today.paid ?? 0) > 0 ? '已动用付费额度' : '全部免费额度' }}
              </a-tag>
            </div>
          </a-col>
          <a-col :span="12">
            <div class="text-xs text-slate-400 leading-relaxed">
              仅统计经本网关的请求——在千问客户端 / 网页里直接对话的部分不计入。
              「今日全部消耗」在上面的额度卡里（由上限减余额得出），
              两套口径<b>不要相加</b>。
            </div>
          </a-col>
        </a-row>
        <a-empty v-if="!qwRecords.length" description="还没有经网关的积分记录" />
        <a-table
          v-else
          size="small"
          :data-source="qwRecords"
          :columns="qwRecordColumns"
          row-key="req_id"
          :pagination="{ pageSize: 10, size: 'small', showSizeChanger: false }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'ts'">
              <span class="text-xs">{{ dateTimeText(record.ts) }}</span>
            </template>
            <template v-else-if="column.key === 'model'">
              <span class="font-mono text-xs">{{ record.model }}</span>
            </template>
            <template v-else-if="column.key === 'pool'">
              <a-tag :color="record.pool === 'daily' ? 'cyan' : (record.pool === 'paid' ? 'blue' : 'default')">
                {{ record.pool === 'daily' ? '免费池' : record.pool === 'paid' ? '付费池' : '—' }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'free'">
              <span class="text-cyan-500">{{ fmtQw(record.free) }}</span>
            </template>
            <template v-else-if="column.key === 'paid'">
              <span class="text-blue-500">{{ fmtQw(record.paid) }}</span>
            </template>
            <template v-else-if="column.key === 'total'">
              <span class="font-medium">{{ fmtQw(record.total) }}</span>
              <a-tooltip v-if="record.concurrent" title="与相邻请求并发，差值可能含其它请求的消耗">
                <a-tag color="orange" class="ml-1">并发</a-tag>
              </a-tooltip>
            </template>
            <template v-else-if="column.key === 'ms'">
              <span class="text-xs text-slate-400">{{ record.ms != null ? record.ms + ' ms' : '—' }}</span>
            </template>
          </template>
        </a-table>
      </a-card>
    </template>

    <!-- 搭子通道：账号池 + 用量 -->
    <template v-else>
    <!-- 顶部指标卡：数据来自 /web-accounts/dashboard（账号池）+ /stats（用量） -->
    <a-row :gutter="[16, 16]">
      <a-col :span="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="账号总数" :value="dash?.summary.total ?? '—'">
            <template #suffix><span class="text-sm text-slate-400">个</span></template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="dash">
              启用 {{ dash.summary.enabled }} · 停用 {{ dash.summary.disabled }}
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="有效期内" :value="dash?.summary.valid ?? '—'" value-style="color:#34d399">
            <template #suffix><span class="text-sm text-slate-400">个</span></template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="dash">
              {{ dash.summary.valid === dash.summary.enabled ? '全部正常' : `${dash.summary.enabled - dash.summary.valid} 个待处理` }}
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic
            title="即将过期"
            :value="dash?.summary.expiring_soon ?? '—'"
            :value-style="dash && dash.summary.expiring_soon > 0 ? 'color:#fbbf24' : ''"
          >
            <template #suffix><span class="text-sm text-slate-400">个</span></template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            {{ dash && dash.summary.expiring_soon > 0 ? '7 天内到期' : '暂无风险' }}
          </div>
        </a-card>
      </a-col>

      <a-col :span="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="积分余额" :value="dash ? dash.summary.points_left : '—'" :precision="2" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="dash">
              <a-tag v-if="dash.summary.low_points" color="orange">
                {{ dash.summary.low_points }} 个低于 200
              </a-tag>
              <span v-else>{{ dash.summary.total }} 个账号合计</span>
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :span="4">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="今日 Token" :value="todayTokensText" value-style="color:#22d3ee" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="stats">{{ stats.today.requests }} 次请求</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>
    </a-row>

    <!-- 趋势 + 上游状态 -->
    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="17">
        <a-card title="近 14 天调用趋势" :bordered="false" class="h-full">
          <a-empty v-if="!daily.length" description="还没有请求记录" />
          <!-- 请求数与 Token 拆成上下两张共享 X 轴的小图，而不是叠在一张图上用双 Y 轴：
               两个量纲的刻度对齐点是任意的，共图会凭空造出「此消彼长」的相关性。
               小倍数保留「同一时间轴上看两条趋势」的能力，又不需要读者在两套刻度间换算。 -->
          <template v-else>
            <div class="trend-block">
              <div class="trend-label">请求数</div>
              <div ref="reqChartEl" class="trend-chart" />
            </div>
            <div class="trend-block">
              <div class="trend-label">Token</div>
              <div ref="tokChartEl" class="trend-chart" />
            </div>
          </template>
        </a-card>
      </a-col>

      <a-col :span="7">
        <a-card title="上游状态" :bordered="false" class="h-full">
          <a-descriptions :column="1" size="small">
            <a-descriptions-item label="网关">
              <a-tag :color="dash?.upstream.gateway_online ? 'green' : 'red'">
                {{ dash?.upstream.gateway_online ? '正常' : '未启动' }}
              </a-tag>
              <span class="text-xs text-slate-400 ml-1">:{{ dash?.upstream.gateway_port ?? 9084 }}</span>
            </a-descriptions-item>
            <a-descriptions-item label="可用账号">
              <template v-if="dash?.upstream.accounts_ready !== null && dash?.upstream.accounts_ready !== undefined">
                {{ dash.upstream.accounts_ready }} / {{ dash.upstream.accounts_total }}
              </template>
              <span v-else class="text-slate-400">—</span>
            </a-descriptions-item>
            <a-descriptions-item label="冷却中">
              <template v-if="dash?.upstream.cooling !== null && dash?.upstream.cooling !== undefined">
                {{ dash.upstream.cooling }}
              </template>
              <span v-else class="text-slate-400">—</span>
            </a-descriptions-item>
            <a-descriptions-item label="本地代理">
              <a-tag :color="status?.gateway.online ? 'green' : 'red'">
                {{ status?.gateway.online ? '在线' : '离线' }}
              </a-tag>
              <span class="text-xs text-slate-400 ml-1">:{{ status?.gateway.port ?? 9080 }}</span>
            </a-descriptions-item>
            <a-descriptions-item label="上游端口">
              {{ status?.upstream.port ?? '—' }}
              <a-tag v-if="status?.upstream.managed" color="blue" class="ml-1">自建</a-tag>
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
      </a-col>
    </a-row>

    <!-- 账号健康快照 -->
    <a-card :bordered="false" class="mt-4">
      <template #title>
        <span>账号健康快照</span>
        <a-tag v-if="dash" color="green" class="ml-2">在线 {{ dash.summary.valid }}</a-tag>
      </template>
      <a-empty v-if="!dash?.accounts.length" description="还没有添加账号" />
      <a-row v-else :gutter="[16, 16]">
        <a-col v-for="a in dash.accounts" :key="a.id" :span="8">
          <div class="p-3 border border-slate-200 rounded">
            <div class="flex items-center justify-between mb-2">
              <span class="font-medium">{{ a.nickname || a.name }}</span>
              <a-tag :color="a.last_error ? 'red' : a.enabled ? 'green' : 'default'">
                {{ a.last_error ? '异常' : a.enabled ? '在线' : '停用' }}
              </a-tag>
            </div>
            <!-- 健康条：长度按会员剩余天数，30 天为满 -->
            <div class="h-1.5 bg-slate-100 rounded overflow-hidden mb-2">
              <div
                class="h-full rounded transition-all"
                :class="healthColor(a)"
                :style="{ width: healthWidth(a) }"
              />
            </div>
            <div class="flex items-center justify-between text-xs">
              <span class="text-slate-500">
                {{ a.days_left !== null ? a.days_left + ' 天' : '到期未知' }}
                <span v-if="a.days_alive !== null" class="text-slate-400 ml-1">
                  · 已用 {{ a.days_alive }} 天
                </span>
              </span>
              <span :class="a.points !== null && a.points < 200 ? 'text-orange-500' : 'text-slate-600'">
                {{ a.points !== null ? fmt(a.points) + ' 积分' : '积分未知' }}
              </span>
            </div>
            <div v-if="a.last_error" class="text-xs text-red-500 mt-1">{{ a.last_error }}</div>
          </div>
        </a-col>
      </a-row>
    </a-card>

    <!-- 用量与账号状态明细 -->
    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :span="12">
        <a-card title="今日用量" :bordered="false">
          <a-descriptions :column="2" size="small" bordered>
            <a-descriptions-item label="请求数">
              {{ stats ? stats.today.requests : '—' }}
              <a-tag v-if="stats?.today.failed" color="red" class="ml-1">失败 {{ stats.today.failed }}</a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="Token">
              {{ stats ? fmt(stats.today.total_tokens) : '—' }}
            </a-descriptions-item>
            <a-descriptions-item label="输入">{{ stats ? fmt(stats.today.input_tokens) : '—' }}</a-descriptions-item>
            <a-descriptions-item label="输出">{{ stats ? fmt(stats.today.output_tokens) : '—' }}</a-descriptions-item>
            <a-descriptions-item label="平均耗时">
              {{ stats ? stats.today.avg_ms + ' ms' : '—' }}
            </a-descriptions-item>
            <a-descriptions-item :label="`累计 ${stats?.days ?? 30} 天`">
              {{ stats ? fmt(stats.total.total_tokens) + ' tokens' : '—' }}
              <span class="text-xs text-slate-400 ml-1">
                / {{ stats ? stats.total.requests : '—' }} 次
              </span>
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
      </a-col>

      <a-col :span="12">
        <a-card title="本地代理账号" :bordered="false">
          <a-table
            size="small"
            :pagination="false"
            :data-source="accounts?.accounts ?? []"
            :columns="accountColumns"
            row-key="user_id"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'state'">
                <a-tag :color="stateColor(record.state)">{{ stateText(record.state) }}</a-tag>
              </template>
              <template v-else-if="column.key === 'web'">
                <a-tag v-if="record.web" color="green">已添加</a-tag>
                <span v-else class="text-xs text-slate-400">未添加</span>
              </template>
            </template>
          </a-table>
          <div class="text-xs text-slate-400 mt-2">
            「本地代理账号」是桌面端凭证（跑模型用），与上面「账号健康快照」的网页凭证是两套。
          </div>
        </a-card>
      </a-col>
    </a-row>

    <a-alert v-if="error" type="warning" show-icon class="mt-4" :message="`部分数据获取失败：${error}`" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import { channelStore, isTraework, isQwenwork } from '@/stores/channel'
import { qwenworkApi, type QwCredits, type QwDailyRow, type QwAccount, type QwCreditRecord } from '@/api/qwenwork'
import { traeworkApi } from '@/api/traework'
import type {
  TraeworkCreditRow, TraeworkDashboard, TraeworkCreditRecord, TraeworkDashAccount,
} from '@/api/traework'
import client from '@/api/client'
import type { SystemStatus } from '@/api/system'
import type { PointsData, AccountsData } from '@/api/points'
import type { StatsSummary, DailyRow } from '@/api/stats'
import type { UsageOverview } from '@/api/usage'
import { SERIES, INK, TOOLTIP_BASE, axisStyle, compactNum, exactNum, lineSeries } from '@/utils/chartTheme'

interface DashAccount {
  id: number
  name: string
  nickname: string
  enabled: boolean
  points: number | null
  points_total: number | null
  subscribed: boolean
  days_left: number | null
  /** 账号存活天数（从 created_at 算到今天），与 days_left 是两回事 */
  days_alive: number | null
  expire_at: number | null
  checkin_result: string
  last_error: string
}

interface DashData {
  summary: {
    total: number; enabled: number; disabled: number; valid: number
    expiring_soon: number; low_points: number
    points_left: number; points_total: number
  }
  upstream: {
    gateway_online: boolean; gateway_port: number
    accounts_total: number | null; accounts_ready: number | null; cooling: number | null
  }
  accounts: DashAccount[]
}

const status = ref<SystemStatus | null>(null)
const points = ref<PointsData | null>(null)
const accounts = ref<AccountsData | null>(null)
const stats = ref<StatsSummary | null>(null)
const daily = ref<DailyRow[]>([])
const dash = ref<DashData | null>(null)
const loading = ref(false)
const error = ref('')
const lastRefresh = ref('')

// 通道：千问办公是另一套账（积分/登录态），整块内容与搭子不同。
// 用 store 的全局状态而不是本地 ref —— 顶栏切换器与这里必须一致。
// 通道：千问与 TRAE 都是直连、账单与搭子不同（isDirectChannel），
// 但两者**彼此也不同**：千问是三个积分池、单账号只读；TRAE 是单一
// credits、多账号自持。所以页面在「非搭子」的骨架里还要再分一次。
const isTw = computed(() => isTraework())
const isQw = computed(() => isQwenwork())
const twInfo = computed(() => channelStore.infos['traework'] || null)
// TRAE 的额度（按账号独立）与经网关的用量（/usage 按通道过滤）是两个数据源
const twRows = ref<TraeworkCreditRow[]>([])
const usage = ref<UsageOverview | null>(null)
// 账号健康快照 + 今日积分明细。dashboard 走本地数据（不打上游），
// records 是逐笔归因——两者都是仪表盘每次进入都要拉的数据
const twDash = ref<TraeworkDashboard | null>(null)
const twRecords = ref<TraeworkCreditRecord[]>([])
const twWindow = ref<{ cost: number; requests: number; exact: number }>({ cost: 0, requests: 0, exact: 0 })
const twAccounts = computed(() => twDash.value?.accounts || [])
const twToday = computed(() => twDash.value?.today || null)
const twTotals = computed(() => {
  let remain: number | null = null
  let limit: number | null = null
  let checked = 0
  for (const r of twRows.value) {
    if (r.remain != null) remain = (remain ?? 0) + r.remain
    if (r.limit != null) limit = (limit ?? 0) + r.limit
    if (r.checkedIn) checked++
  }
  return { remain, limit, checked }
})
const qw = ref<QwCredits | null>(null)
const qwDaily = ref<QwDailyRow[]>([])
// 账号健康快照用——千问现在也是多账号池，每个账号一张卡
const qwAccounts = ref<QwAccount[]>([])
// 今日积分明细：逐笔归因，按 req_id 与请求日志配对
const qwRecords = ref<QwCreditRecord[]>([])
const qwWindow = ref<{ free: number; paid: number; total: number; requests: number }>(
  { free: 0, paid: 0, total: 0, requests: 0 },
)
const qwInfo = computed(() => channelStore.infos['qwenwork'] || null)
// 三个池子。后端平级返回 wallets，前端不再自己合并——「月度」与「长期」
// 一个来自订阅套餐、一个来自充值赠送，合并成一张「付费额度」卡会丢信息。
const qwWallets = computed(() => qw.value?.wallets || [])

function fmtExpire(iso?: string | null) {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

const accountColumns = [
  { title: '账号', key: 'name', dataIndex: 'name' },
  { title: '桌面凭证', key: 'state', width: '20%' },
  { title: '网页凭证', key: 'web', width: '20%' },
]

// TRAE 今日积分明细的列。cost 与 remain 分开两列——前者是「这条花了多少」，
// 后者是「花完还剩多少」，混成一列会被读成同一个指标。
const twRecordColumns = [
  { title: '时间', key: 'ts', width: '20%' },
  { title: '账号', key: 'account', width: '18%' },
  { title: '模型', key: 'model', width: '16%' },
  { title: '本次消耗', key: 'cost', width: '16%' },
  { title: '剩余额度', key: 'remain', width: '14%' },
  { title: '耗时', key: 'ms', width: '12%' },
]

// 千问今日积分明细的列。免费与付费分列——这个通道有三个池子，
// 「消耗的是免费额度还是付费额度」比「花了多少」更要紧。
const qwRecordColumns = [
  { title: '时间', key: 'ts', width: '18%' },
  { title: '模型', key: 'model', width: '16%' },
  { title: '池', key: 'pool', width: '10%' },
  { title: '免费', key: 'free', width: '14%' },
  { title: '付费', key: 'paid', width: '14%' },
  { title: '合计', key: 'total', width: '16%' },
  { title: '耗时', key: 'ms', width: '12%' },
]

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
// 千问的积分单位很小（单次请求 0.0025 级别），两位小数会把它们全显示成 0.00。
// 所以这个通道单独用四位小数——与 PointsView 的口径一致。
const fmtQw = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
const dateTimeText = (ts: number) =>
  new Date(ts).toLocaleString('zh-CN', { hour12: false })
const compact = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B'
    : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)

const todayTokensText = computed(() =>
  stats.value ? compact(stats.value.today.total_tokens) : '—')

const stateColor = (s: string) => {
  if (s === 'active') return 'green'
  if (s === 'standby') return 'blue'
  if (s === 'no_credential') return 'orange'
  return 'default'
}
const stateText = (s: string) => {
  if (s === 'active') return '使用中'
  if (s === 'standby') return '备用'
  if (s === 'no_credential') return '无凭证'
  return '未知'
}

// 健康条：按会员剩余天数，30 天为满格。
// 用天数而不是积分——积分随时会被模型消耗，天天在变；到期日是稳定的寿命指标。
function healthWidth(a: DashAccount) {
  if (a.days_left === null) return '0%'
  const pct = Math.max(0, Math.min(100, (a.days_left / 30) * 100))
  return pct + '%'
}
function healthColor(a: DashAccount) {
  if (a.last_error) return 'bg-red-400'
  if (a.days_left === null) return 'bg-slate-300'
  if (a.days_left <= 7) return 'bg-orange-400'
  return 'bg-green-500'
}

// 千问版：按账号存活天数（从 createdAt 算到今天），365 天为满格。
// 与搭子的语义不同——「剩余」vs「已活」，但视觉规则一致：0 用灰、
// 离线/异常用红/橙、在线用绿。「待重登」也算异常色——这条通道的
// refresh token 是池里这个号自己持有的，不该再走客户端。
function healthWidthQw(a: QwAccount) {
  if (a.daysAlive === null) return '0%'
  const pct = Math.max(0, Math.min(100, (a.daysAlive / 365) * 100))
  return pct + '%'
}
function healthColorQw(a: QwAccount) {
  if (a.lastError) return 'bg-red-400'
  if (a.refreshExpired) return 'bg-orange-400'
  if (!a.enabled || !a.usable) return 'bg-slate-300'
  return 'bg-green-500'
}

// TRAE 版：与千问同一套视觉规则（0 用灰、异常用红/橙、在线用绿），
// 但长度按**剩余额度占上限的比例**——TRAE 的 credits 是会被消耗掉的
// 余额（签到补充），「还剩多少」才是这个通道最要紧的寿命指标。
// 上限取不到（接口不给）时退化为按存活天数，并在卡片上标注来源。
/** 健康条的额度上限：取所有账号里最大的 limit，没有则 null（退化到天数） */
const twCreditCap = computed(() => {
  let cap: number | null = null
  for (const r of twRows.value) if (r.limit != null && (cap === null || r.limit > cap)) cap = r.limit
  return cap
})
function healthWidthTw(a: TraeworkDashAccount) {
  const cap = twCreditCap.value
  if (cap && a.credits != null) {
    const pct = Math.max(0, Math.min(100, (a.credits / cap) * 100))
    return pct + '%'
  }
  if (a.daysAlive === null) return '0%'
  const pct = Math.max(0, Math.min(100, (a.daysAlive / 365) * 100))
  return pct + '%'
}
function healthColorTw(a: TraeworkDashAccount) {
  if (a.lastError) return 'bg-red-400'
  if (a.refreshExpired) return 'bg-orange-400'
  if (!a.enabled) return 'bg-slate-300'
  const cap = twCreditCap.value
  if (cap && a.credits != null && a.credits < cap * 0.1) return 'bg-orange-400'
  return 'bg-green-500'
}

// 趋势图用 ECharts 按需引入：只加载折线图需要的模块，
// 比全量引入（约 1MB）小得多，也避免为一个图表拖慢首屏。
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart, GridComponent, TooltipComponent, LegendComponent,
  DataZoomComponent, CanvasRenderer,
])

const reqChartEl = ref<HTMLElement | null>(null)
const tokChartEl = ref<HTMLElement | null>(null)
let reqChart: echarts.ECharts | null = null
let tokChart: echarts.ECharts | null = null

// 两张小倍数图共享同一套 X 轴刻度与 grid，纵向对齐后可以当作一条时间轴来读。
// 拆开而不是双 Y 轴：双轴的刻度对齐点没有依据，会让人读出并不存在的相关性。
function renderChart() {
  const rows = daily.value
  const days = rows.map((r) => r.day.slice(5))
  // 共享的 X 轴配置：只在下面那张显示标签，避免重复占用垂直空间
  const baseGrid = { left: 56, right: 16, top: 8, bottom: 4 }
  const xAxisCommon = {
    type: 'category' as const,
    data: days,
    boundaryGap: false,
    axisLine: { show: true, lineStyle: { color: INK.axis } },
    axisTick: { show: false },
  }
  const tooltipCommon = {
    ...TOOLTIP_BASE,
    trigger: 'axis' as const,
    axisPointer: {
      type: 'line' as const,
      lineStyle: { color: INK.axis, width: 1 },
    },
  }

  if (reqChartEl.value) {
    if (!reqChart) reqChart = echarts.init(reqChartEl.value)
    reqChart.setOption({
      grid: baseGrid,
      tooltip: {
        ...tooltipCommon,
        formatter: (params: any[]) => {
          const r = rows[params[0].dataIndex]
          return `${r.day}<br/>请求 <b>${exactNum(r.requests)}</b>`
        },
      },
      xAxis: { ...xAxisCommon, axisLabel: { show: false } },
      yAxis: {
        type: 'value',
        ...axisStyle({ formatter: (v: number) => compactNum(v) }),
      },
      series: [
        lineSeries({
          name: '请求数',
          data: rows.map((r) => r.requests),
          color: SERIES[0],
          area: true,
        }),
      ],
    })
  }

  if (tokChartEl.value) {
    if (!tokChart) tokChart = echarts.init(tokChartEl.value)
    tokChart.setOption({
      grid: { ...baseGrid, bottom: 22 },
      tooltip: {
        ...tooltipCommon,
        formatter: (params: any[]) => {
          const r = rows[params[0].dataIndex]
          return `${r.day}<br/>Token <b>${exactNum(r.total_tokens)}</b>`
        },
      },
      xAxis: { ...xAxisCommon, axisLabel: { color: INK.muted, fontSize: 11 } },
      yAxis: {
        type: 'value',
        ...axisStyle({ formatter: (v: number) => compactNum(v) }),
      },
      series: [
        lineSeries({
          name: 'Token',
          data: rows.map((r) => r.total_tokens),
          color: SERIES[1],
          area: true,
        }),
      ],
    })
  }
}

// 千问办公的数据单独拉：它走的是 /qwenwork/* 而不是搭子那套接口，
// 两者混在一个 Promise.all 里会让任一通道故障拖垮整页。
async function refreshQw() {
  loading.value = true
  error.value = ''
  try {
    const [c, d, a, rec] = await Promise.all([
      qwenworkApi.credits(),
      qwenworkApi.daily(14),
      // 账号健康快照用——不取的话下面那块只是空骨架
      qwenworkApi.accounts(),
      // 今日积分明细（逐笔归因）
      qwenworkApi.creditRecords(200).catch(() => ({ data: { rows: [], window: { free: 0, paid: 0, total: 0, requests: 0 } } })),
    ])
    qw.value = c.data
    qwDaily.value = d.data.rows
    qwAccounts.value = (a.data && a.data.accounts) || []
    qwRecords.value = (rec.data && rec.data.rows) || []
    qwWindow.value = (rec.data && rec.data.window) || { free: 0, paid: 0, total: 0, requests: 0 }
    await channelStore.load()
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    await nextTick()
    renderQwChart()
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

// TRAE Work 的数据分三路拉：额度（/traework/credits）、用量（/usage 按通道
// 过滤）、通道元信息（system/status）。与千问分开是因为两者的账完全不同，
// 混在一个 Promise.all 里会让任一通道故障拖垮整页。
async function refreshTw() {
  loading.value = true
  error.value = ''
  try {
    const [c, u, d, r] = await Promise.all([
      traeworkApi.credits().catch(() => ({ data: { count: 0, rows: [] } })),
      client.get(`/usage/overview?days=14&channel=traework`).catch(() => ({ data: null })),
      // 账号健康快照 + 今日消耗：本地数据，不打上游（见后端 /dashboard 注释）
      traeworkApi.dashboard().catch(() => ({ data: null })),
      traeworkApi.creditRecords(200).catch(() => ({ data: { rows: [], window: { cost: 0, requests: 0, exact: 0 } } })),
    ])
    twRows.value = c.data.rows || []
    usage.value = u.data
    twDash.value = d.data
    twRecords.value = (r.data && r.data.rows) || []
    twWindow.value = (r.data && r.data.window) || { cost: 0, requests: 0, exact: 0 }
    await channelStore.load()
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    await nextTick()
    renderTokChart()
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

// TRAE 的趋势图复用搭子 token 那张的容器：只画请求量一条线就够回答
// 「这条通道用得多不多」，额度是存量（不是时间序列），不该画成折线。
function renderTokChart() {
  const rows = usage.value?.daily || []
  if (!tokChartEl.value || !rows.length) return
  if (!tokChart) tokChart = echarts.init(tokChartEl.value)
  tokChart.setOption({
    grid: { left: 56, right: 16, top: 12, bottom: 22 },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      formatter: (params: any[]) => {
        const r = rows[params[0].dataIndex]
        return `${r.day}<br/>请求 <b>${exactNum(r.requests)}</b><br/>Token <b>${exactNum(r.total_tokens)}</b>`
      },
    },
    xAxis: { type: 'category', data: rows.map((r) => r.day.slice(5)), ...axisStyle({ showGrid: false }) },
    yAxis: { type: 'value', ...axisStyle({ formatter: (v: number) => compactNum(v) }) },
    series: [lineSeries({ name: '请求数', data: rows.map((r) => r.requests), color: SERIES[0], area: true })],
  })
}

async function refresh(force = false) {
  if (isTw.value) return refreshTw()
  if (isQw.value) return refreshQw()
  loading.value = true
  error.value = ''
  try {
    const [s, p, a, st, dy, db] = await Promise.all([
      client.get('/system/status'),
      client.get('/points/points' + (force ? '?refresh=1' : '')),
      client.get('/points/accounts'),
      client.get('/stats/summary'),
      client.get('/stats/daily?days=14'),
      client.get('/web-accounts/dashboard'),
    ])
    status.value = s.data
    points.value = p.data
    accounts.value = a.data
    stats.value = st.data
    daily.value = dy.data.rows
    dash.value = db.data
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    // 等 DOM 更新后再渲染，否则 ref 还没挂上
    await nextTick()
    renderChart()
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

// 千问积分趋势：免费与付费堆叠。分开画是因为「消耗的是免费额度还是
// 付费额度」是本通道最要紧的一件事——堆叠能一眼看出付费是否开始被动用。
const qwChartEl = ref<HTMLElement | null>(null)
let qwChart: echarts.ECharts | null = null

function renderQwChart() {
  const rows = qwDaily.value
  if (!qwChartEl.value || !rows.length) return
  if (!qwChart) qwChart = echarts.init(qwChartEl.value)
  const days = rows.map((r) => r.day.slice(5))
  qwChart.setOption({
    grid: { left: 56, right: 16, top: 12, bottom: 24 },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      formatter: (params: any[]) => {
        const r = rows[params[0].dataIndex]
        return `${r.day}<br/>免费 <b>${exactNum(r.free)}</b><br/>付费 <b>${exactNum(r.paid)}</b><br/>请求 ${exactNum(r.requests)} 次`
      },
    },
    legend: { data: ['免费额度', '付费额度'], right: 0, top: 0, textStyle: { color: INK.secondary, fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
    xAxis: { type: 'category', data: days, boundaryGap: false, axisLine: { show: true, lineStyle: { color: INK.axis } }, axisTick: { show: false }, axisLabel: { color: INK.muted, fontSize: 11 } },
    // 积分量级很小（单次请求 0.0025~0.02），compactNum 会把刻度全取整成
    // 1/0，看不出差别——这里用小数位而不是紧凑格式。
    yAxis: { type: 'value', ...axisStyle({ formatter: (v: number) => (v === 0 ? '0' : v.toFixed(2)) }) },
    series: [
      { ...lineSeries({ name: '免费额度', data: rows.map((r) => r.free), color: SERIES[2], area: true }), stack: 'credit' },
      { ...lineSeries({ name: '付费额度', data: rows.map((r) => r.paid), color: SERIES[1], area: true }), stack: 'credit' },
    ],
  })
}

function onResize() {
  reqChart?.resize()
  tokChart?.resize()
  qwChart?.resize()
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  refresh()
})

// 切通道要重拉数据：三条通道的数据源不同，不重拉会看到上一个通道的残留。
// 两个 computed 都要 watch——只盯 isQw 的话从搭子切到 TRAE 不触发。
watch([isQw, isTw], () => { refresh() })

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  reqChart?.dispose()
  tokChart?.dispose()
  qwChart?.dispose()
  reqChart = null
  tokChart = null
  qwChart = null
})
</script>

<style scoped>
/* TRAE 的趋势图：单张，比搭子的两联图高一些——它只画一条线，
   给足高度才能看出起伏 */
.dash-chart {
  height: 260px;
  width: 100%;
}
.qw-chart {
  height: 260px;
  width: 100%;
}
/* 两张小倍数图：上下贴紧、共享一条时间轴，读起来仍是一条趋势带 */
.trend-block + .trend-block {
  margin-top: 2px;
}
.trend-label {
  font-size: 11px;
  color: var(--lab-text-mute);
  padding-left: 2px;
}
/* 高度含 X 轴标签带，避免容器把轴标签裁掉后卡片里出现内嵌滚动条 */
.trend-chart {
  height: 112px;
  width: 100%;
}
</style>
