//theoretically fade out screen and leave in letters 'loading' burned in
ui/assets/loading
{
	{
		map ui/assets/loading.tga
		blendfunc gl_dst_color gl_src_color
	}
}

gfx/ui/ingamemenubg
{
	{
		map gfx/ui/ingamemenubg.tga
		blendfunc blend
	}
}

ui/assets/ingame
{
	{
		map ui/assets/ingame.tga
		blendfunc gl_dst_color gl_src_color
	}
}

// concept: fading background sequences of levels
gfx/ui/menubg
{
	{
		animmap 0.09 env/anoice1/anoice1_bk.tga env/anoice1/anoice1_ft.tga env/anoice1/anoice1_lf.tga env/anoice1/anoice1_rt.tga 
	}
}

