Damit /dev/zd0 zum LVM hinzugefügt werden kann:
/etc/lvm/lvm.conf 
global_filter=["a|/dev/zd0|","r|/dev/zd.*|","r|/dev/rbd.*|"]
