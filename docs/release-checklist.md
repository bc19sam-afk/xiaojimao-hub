# 上线前最小检查清单

本清单只做发布收口，不替代真实外部验收，也不授权部署或修改 CPAMP。

- [ ] 域名、DNS、HTTPS 证书与自动续期已确认；nginx 80→443 使用固定域名，安全头和 body/proxy timeout 已生效。
- [ ] `APP_BASE_URL` 固定为最终 HTTPS 地址；Linux.do 回调地址与它逐字一致。
- [ ] `.env` 为 `0600`，不在 Git/镜像/日志中；`MOCK=false`、强 `SESSION_SECRET`、CPA/管理员配置齐全。
- [ ] 复核管理员白名单/密码、信任门槛、积分费率、入池优先级、结算 grace、商品、限购与 CDK/LDC 库存。
- [ ] `/api/health`、`/api/ready` 与 dead-man 心跳告警都已接线；普通用户不能触发全局 `verify-now`。
- [ ] 异机备份持续同步；在目标机完成一次受控 restore 演练，并记录最近成功时间与恢复耗时。
- [ ] 核对容器时区、磁盘余量、Docker 日志轮转；明确升级窗口、回滚负责人和回滚点。
- [ ] 用真实 Linux.do 应用完成登录/退出；用一次性测试目标验证真实 CPA 写链（含 `setPriority`）并清理回原状。
- [ ] 用一个明确授权的真号完成提交→首检→入池→计量/积分的 E2E；失败即停止发布，不用 MOCK 结果替代。
- [ ] 部署后观察日志、ready、worker 心跳、备份、首检积压和积分流水至少一个完整 worker/结算窗口。
- [ ] P7 只做容量观测：记录 CPA usage detail/request rows 当前量与日增长；接近 **50,000** 时告警并安排后续方案。本轮不改 CPAMP 或分页架构。
