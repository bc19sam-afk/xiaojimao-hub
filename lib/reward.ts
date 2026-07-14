import { randomBytes } from 'crypto'
import { env } from './env'

// ============================================================================
// 奖励发放抽象层
//
// MOCK：生成一个模拟兑换码（真实可用的码串，能显示、能复制）。
// 真实：把 grantReward 换成调用小鸡毛公益站的发码/加额度接口即可，
//       上层（worker、collect）不用改。
// ============================================================================

export interface RewardResult {
  code: string
  text: string
  note: string
}

// 生成一个模拟兑换码，形如 XJM-A1B2-C3D4
function mockCode(): string {
  const raw = randomBytes(4).toString('hex').toUpperCase()
  return `XJM-${raw.slice(0, 4)}-${raw.slice(4, 8)}`
}

export async function grantReward(_ctx: {
  linuxdoId: number
  accountId: string
}): Promise<RewardResult> {
  // TODO(real): 这里调小鸡毛发码/加额度接口，用 _ctx 关联到具体用户
  return {
    code: mockCode(),
    text: env.reward.text,
    note: env.reward.note,
  }
}
